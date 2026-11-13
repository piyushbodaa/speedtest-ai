import type { GaugeTick, PhaseId, PhaseResult, SpeedGrade } from '../types.js';
import { estimateTokens } from './tokenizer.js';

interface TokenSample {
  atMs: number;
  tokens: number;
  kind: 'text' | 'thinking';
}

export interface ReportedUsage {
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  promptEvalDurationMs?: number;
  evalDurationMs?: number;
  apiDurationMs?: number;
  costUsd?: number;
}

export function computeGrade(tps: number): SpeedGrade {
  if (tps >= 140) return 'HYPER';
  if (tps >= 80) return 'TURBO';
  if (tps >= 40) return 'CRUISING';
  if (tps >= 20) return 'STEADY';
  return 'CRAWLING';
}

export function sanitizePreviewText(text: string, maxLen = 60): string {
  const cleaned = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trimStart();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(cleaned.length - maxLen);
}

export class RollingSpeedTracker {
  readonly phase: PhaseId;
  readonly requestStartMs: number;

  initMs?: number;
  firstTokenMs?: number;
  lastTokenMs?: number;
  detectedModel?: string;

  private samples: TokenSample[] = [];
  private chunkTimestampsMs: number[] = [];
  private chunkTokenCounts: number[] = [];
  private firstChunkTokens = 0;

  private estimatedTextTokens = 0;
  private estimatedThinkingTokens = 0;
  private textBuffer = '';
  private thinkingBuffer = '';
  private previewBuffer = '';
  private toolCalls = 0;

  private smoothedTps = 0;
  private hasSmoothed = false;
  private peakTps = 0;

  constructor(phase: PhaseId, requestStartMs: number) {
    this.phase = phase;
    this.requestStartMs = requestStartMs;
  }

  markInit(atMs: number, model?: string): void {
    if (this.initMs === undefined) {
      this.initMs = atMs;
    }
    if (model) {
      this.detectedModel = model;
    }
  }

  setModel(model?: string): void {
    if (model) {
      this.detectedModel = model;
    }
  }

  recordToolCall(): void {
    this.toolCalls += 1;
  }

  recordDelta(text: string, kind: 'text' | 'thinking', atMs: number): void {
    if (!text) return;

    const tokens = estimateTokens(text);
    if (this.firstTokenMs === undefined) {
      this.firstTokenMs = atMs;
      this.firstChunkTokens = tokens;
    }
    this.lastTokenMs = atMs;

    this.samples.push({ atMs, tokens, kind });
    this.chunkTimestampsMs.push(atMs);
    this.chunkTokenCounts.push(tokens);

    if (kind === 'thinking') {
      this.estimatedThinkingTokens += tokens;
      this.thinkingBuffer += text;
    } else {
      this.estimatedTextTokens += tokens;
      this.textBuffer += text;
    }

    this.previewBuffer += text;
    if (this.previewBuffer.length > 240) {
      this.previewBuffer = this.previewBuffer.slice(-240);
    }
  }

  get totalEstimatedTokens(): number {
    return this.estimatedTextTokens + this.estimatedThinkingTokens;
  }

  get chunkCount(): number {
    return this.chunkTimestampsMs.length;
  }

  get responseText(): string {
    return this.textBuffer;
  }

  computeCurrentTps(nowMs: number): number {
    if (this.firstTokenMs === undefined || this.totalEstimatedTokens === 0) {
      return 0;
    }

    const sinceFirst = nowMs - this.firstTokenMs;
    const windowMs = 1200;
    const windowStart = nowMs - windowMs;

    let windowTokens = 0;
    let firstIncluded = false;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      if (s.atMs >= windowStart && s.atMs <= nowMs) {
        if (i === 0) {
          firstIncluded = true;
        }
        windowTokens += s.tokens;
      }
    }

    let denomMs = windowMs;
    if (sinceFirst < windowMs) {
      denomMs = Math.max(250, sinceFirst);
      // Exclude the initial arrival chunk when measuring inter-token rate in the first window
      if (firstIncluded && this.samples.length > 1 && sinceFirst > 0) {
        windowTokens = Math.max(0, windowTokens - this.firstChunkTokens);
      }
    }

    const rawTps = windowTokens / (denomMs / 1000);

    if (!this.hasSmoothed) {
      this.smoothedTps = rawTps;
      this.hasSmoothed = true;
    } else {
      this.smoothedTps = this.smoothedTps * 0.65 + rawTps * 0.35;
    }

    if (sinceFirst >= 400 && this.totalEstimatedTokens >= 8) {
      if (this.smoothedTps > this.peakTps) {
        this.peakTps = this.smoothedTps;
      }
    }

    return Math.round(this.smoothedTps * 10) / 10;
  }

  computeAverageDecodeTps(nowMs: number): number {
    const total = this.totalEstimatedTokens;
    if (total === 0 || this.firstTokenMs === undefined) return 0;

    const spanMs = Math.max(150, nowMs - this.firstTokenMs);
    if (this.chunkCount >= 2 && spanMs >= 150) {
      const decodeTokens = Math.max(1, total - this.firstChunkTokens);
      return Math.round((decodeTokens / (spanMs / 1000)) * 10) / 10;
    }
    const e2eMs = Math.max(150, nowMs - this.requestStartMs);
    return Math.round((total / (e2eMs / 1000)) * 10) / 10;
  }

  computeJitterAndItl(): { medianItlMs: number; jitterMs: number } {
    if (this.chunkTimestampsMs.length < 2) {
      return { medianItlMs: 0, jitterMs: 0 };
    }

    const itls: number[] = [];
    for (let i = 1; i < this.chunkTimestampsMs.length; i++) {
      const dt = Math.max(0, this.chunkTimestampsMs[i] - this.chunkTimestampsMs[i - 1]);
      const tok = Math.max(1, this.chunkTokenCounts[i]);
      itls.push(dt / tok);
    }

    const sorted = [...itls].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianItlMs =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

    let jitterMs = 0;
    if (itls.length >= 2) {
      let diffSum = 0;
      for (let i = 1; i < itls.length; i++) {
        diffSum += Math.abs(itls[i] - itls[i - 1]);
      }
      jitterMs = diffSum / (itls.length - 1);
    }

    return {
      medianItlMs: Math.round(medianItlMs * 10) / 10,
      jitterMs: Math.round(jitterMs * 10) / 10,
    };
  }

  toGaugeTick(nowMs: number): GaugeTick {
    const currentTps = this.computeCurrentTps(nowMs);
    const averageTps = this.computeAverageDecodeTps(nowMs);
    const { jitterMs } = this.computeJitterAndItl();
    const ttftMs =
      this.firstTokenMs !== undefined ? Math.max(1, Math.round(this.firstTokenMs - this.requestStartMs)) : undefined;
    const elapsedSec = ((nowMs - this.requestStartMs) / 1000).toFixed(1);
    let statusHint: string | undefined;
    if (this.firstTokenMs === undefined) {
      statusHint =
        this.initMs !== undefined
          ? `Connected${this.detectedModel ? ` (${this.detectedModel})` : ''} · model reasoning / waiting for first token... (${elapsedSec}s)`
          : `Booting CLI harness... (${elapsedSec}s)`;
    }

    return {
      phase: this.phase,
      elapsedMs: Math.max(0, Math.round(nowMs - this.requestStartMs)),
      currentTps,
      averageTps,
      peakTps: Math.round(Math.max(this.peakTps, currentTps) * 10) / 10,
      tokensGenerated: this.totalEstimatedTokens,
      ttftMs,
      jitterMs: this.chunkCount >= 3 ? jitterMs : undefined,
      previewText: sanitizePreviewText(this.previewBuffer),
      model: this.detectedModel,
      statusHint,
    };
  }

  finalize(
    completeMs: number,
    reported?: ReportedUsage,
    estimatedInputTokensFallback = 0,
    verified?: boolean
  ): PhaseResult {
    const durationMs = Math.max(1, Math.round(completeMs - this.requestStartMs));
    const ttftMs =
      this.firstTokenMs !== undefined
        ? Math.max(1, Math.round(this.firstTokenMs - this.requestStartMs))
        : durationMs;
    const initMs =
      this.initMs !== undefined ? Math.max(0, Math.round(this.initMs - this.requestStartMs)) : undefined;

    const estimatedTotal = this.totalEstimatedTokens;
    const hasReportedOutput = typeof reported?.outputTokens === 'number' && reported.outputTokens > 0;
    const outputTokens = hasReportedOutput ? reported!.outputTokens! : estimatedTotal;
    const tokenSource: 'reported' | 'estimated' = hasReportedOutput ? 'reported' : 'estimated';

    const scale = estimatedTotal > 0 ? outputTokens / estimatedTotal : 1;
    const scaledFirstChunkTokens = this.firstChunkTokens * scale;

    let decodeTps: number;
    let isBuffered: boolean;

    if (reported?.evalDurationMs && reported.evalDurationMs > 50 && outputTokens > 0) {
      decodeTps = outputTokens / (reported.evalDurationMs / 1000);
      isBuffered = this.chunkCount < 2;
    } else if (
      this.chunkCount >= 3 &&
      this.firstTokenMs !== undefined &&
      this.lastTokenMs !== undefined &&
      this.lastTokenMs - this.firstTokenMs >= 150
    ) {
      const decodeTokens = Math.max(1, outputTokens - scaledFirstChunkTokens);
      decodeTps = decodeTokens / ((this.lastTokenMs - this.firstTokenMs) / 1000);
      isBuffered = false;
    } else {
      if (
        outputTokens > 0 &&
        this.lastTokenMs !== undefined &&
        this.initMs !== undefined &&
        this.lastTokenMs > this.initMs + 50
      ) {
        decodeTps = outputTokens / ((this.lastTokenMs - this.initMs) / 1000);
      } else {
        decodeTps = outputTokens / Math.max(0.05, durationMs / 1000);
      }
      isBuffered = true;
    }

    const e2eTps = outputTokens / Math.max(0.05, durationMs / 1000);
    const { medianItlMs, jitterMs } = this.computeJitterAndItl();

    const inputTokens =
      typeof reported?.inputTokens === 'number' && reported.inputTokens > 0
        ? reported.inputTokens
        : estimatedInputTokensFallback;

    let prefillTps: number | undefined;
    if (this.phase === 'upload' && inputTokens > 0) {
      if (reported?.promptEvalDurationMs && reported.promptEvalDurationMs > 10) {
        prefillTps = Math.round((inputTokens / (reported.promptEvalDurationMs / 1000)) * 10) / 10;
      } else {
        // Subtract harness boot overhead if init event was emitted prior to prefill
        const prefillMs =
          initMs !== undefined && ttftMs > initMs + 25 ? ttftMs - initMs : ttftMs;
        prefillTps = Math.round((inputTokens / Math.max(0.02, prefillMs / 1000)) * 10) / 10;
      }
    }

    const roundedDecode = Math.round(decodeTps * 10) / 10;
    const finalPeak = isBuffered ? roundedDecode : Math.max(this.peakTps, roundedDecode);

    return {
      phase: this.phase,
      durationMs,
      ttftMs,
      initMs,
      decodeTps: roundedDecode,
      e2eTps: Math.round(e2eTps * 10) / 10,
      peakTps: Math.round(finalPeak * 10) / 10,
      prefillTps,
      inputTokens,
      cachedInputTokens: reported?.cachedInputTokens,
      outputTokens,
      thinkingTokens: Math.round(this.estimatedThinkingTokens * scale),
      tokenSource,
      isBuffered,
      medianItlMs,
      jitterMs,
      toolCalls: this.toolCalls,
      verified,
      costUsd: reported?.costUsd,
      model: reported?.model,
      responseText: this.textBuffer.trim(),
    };
  }
}
