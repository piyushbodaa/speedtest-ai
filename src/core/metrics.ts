import type {
  AdapterStreamChunk,
  GaugeStage,
  GaugeTick,
  PhaseId,
  PhaseResult,
  RankMetric,
  SpeedGrade,
  SpeedtestResult,
} from '../types.js';
import { countWords, StreamTokenCounter } from './tokenizer.js';

/** Streaming-validity rule (design section 2). */
export const MIN_STREAM_CHUNKS = 8;
export const MIN_STREAM_SPAN_MS = 1000;
export const MAX_SINGLE_CHUNK_SHARE = 0.5;
export const PEAK_WINDOW_MS = 1000;
export const SHORT_OUTPUT_MIN_STREAM_MS = 2000;
export const SHORT_OUTPUT_MIN_TOKENS = 150;
export const MIN_PREFILL_OVERHEAD_MS = 500;

interface VisibleSample {
  atMs: number;
  tokens: number;
}

export interface ReportedUsage {
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  promptEvalDurationMs?: number;
  evalDurationMs?: number;
  apiDurationMs?: number;
  costUsd?: number;
}

const USAGE_KEYS = [
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningTokens',
  'promptEvalDurationMs',
  'evalDurationMs',
  'apiDurationMs',
  'costUsd',
] as const;

export function computeGrade(tps: number): SpeedGrade {
  if (tps >= 140) return 'HYPER';
  if (tps >= 80) return 'TURBO';
  if (tps >= 40) return 'CRUISING';
  if (tps >= 20) return 'STEADY';
  return 'CRAWLING';
}

/** The rate a phase is ranked and graded on: decode TPS when streaming is valid, else E2E TPS. */
export function rankOf(phase: Pick<PhaseResult, 'streaming' | 'decodeTps' | 'e2eTps'>): {
  rankTps: number;
  rankMetric: RankMetric;
} {
  if (phase.streaming && phase.decodeTps !== null) {
    return { rankTps: phase.decodeTps, rankMetric: 'decode' };
  }
  return { rankTps: phase.e2eTps, rankMetric: 'e2e' };
}

/**
 * Leaderboard order: every streaming target (by decode TPS, descending) ranks before every
 * buffered target (by E2E TPS, descending).
 */
export function compareResultsByRank(a: SpeedtestResult, b: SpeedtestResult): number {
  const aStream = a.summary.rankMetric === 'decode' ? 0 : 1;
  const bStream = b.summary.rankMetric === 'decode' ? 0 : 1;
  if (aStream !== bStream) return aStream - bStream;
  return b.summary.rankTps - a.summary.rankTps;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function sanitizePreviewText(text: string, maxLen = 60): string {
  const cleaned = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trimStart();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(cleaned.length - maxLen);
}

export interface FinalizeOptions {
  /** Used for `durationMs` only when the target produced no content, usage or terminal event. */
  endMs: number;
  /** Normalized tokens of the prompt that was sent. */
  promptTokens?: number;
  verified?: boolean;
}

/**
 * Collects the timestamped chunks of one phase and derives every metric from them.
 * All times are `performance.now()` values; `t0Ms` is the spawn / request-sent moment.
 */
export class RollingSpeedTracker {
  readonly phase: PhaseId;

  private t0Ms: number;
  private readyAtMs?: number;
  private firstActivityAtMs?: number;
  private firstVisibleAtMs?: number;
  private lastVisibleAtMs?: number;
  private lastEventAtMs?: number;
  private terminalAtMs?: number;

  private samples: VisibleSample[] = [];
  private firstChunkTokens = 0;
  private maxChunkTokens = 0;
  private visibleCounter = new StreamTokenCounter();
  private thinkingCounter = new StreamTokenCounter();
  private textBuffer = '';
  private previewBuffer = '';
  private lastDeltaKind: 'text' | 'thinking' | undefined;

  private peak = 0;
  private windowStartIdx = 0;
  private windowTokens = 0;

  private toolCallCount = 0;
  private declaredBuffered = false;
  private reported: ReportedUsage = {};
  private noteList: string[] = [];
  private extra: Record<string, number | string | boolean> = {};

  constructor(phase: PhaseId, t0Ms: number) {
    this.phase = phase;
    this.t0Ms = t0Ms;
  }

  get startMs(): number {
    return this.t0Ms;
  }

  get hasContent(): boolean {
    return this.firstActivityAtMs !== undefined || this.lastEventAtMs !== undefined;
  }

  get sawTerminal(): boolean {
    return this.terminalAtMs !== undefined;
  }

  get responseText(): string {
    return this.textBuffer;
  }

  get visibleTokens(): number {
    return this.visibleCounter.total;
  }

  get thinkingTokens(): number {
    return this.thinkingCounter.total;
  }

  get chunkCount(): number {
    return this.samples.length;
  }

  get toolCalls(): number {
    return this.toolCallCount;
  }

  get model(): string | undefined {
    return this.reported.model;
  }

  get notes(): string[] {
    return [...this.noteList];
  }

  /** Feeds one adapter chunk with the time it arrived. This is the only entry point the runner needs. */
  record(chunk: AdapterStreamChunk, atMs: number): void {
    if (chunk.kind === 'start') {
      // A respawn (fallback route) restarts the clock, but only while nothing has been measured.
      if (!this.hasContent) {
        this.t0Ms = atMs;
        this.readyAtMs = undefined;
      }
      return;
    }

    if (this.readyAtMs === undefined) this.readyAtMs = atMs;
    if (this.terminalAtMs !== undefined) return;

    if (chunk.model) this.reported.model = chunk.model;
    if (chunk.buffered) this.declaredBuffered = true;
    if (chunk.extra) Object.assign(this.extra, chunk.extra);
    let carriesUsage = false;
    for (const key of USAGE_KEYS) {
      const value = chunk[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        this.reported[key] = value;
        carriesUsage = true;
      }
    }

    switch (chunk.kind) {
      case 'activity':
        this.markActivity(atMs);
        break;
      case 'thinking':
        if (chunk.text) this.recordDelta(chunk.text, 'thinking', atMs);
        break;
      case 'text':
        if (chunk.text) this.recordDelta(chunk.text, 'text', atMs);
        break;
      case 'tool_call':
        this.toolCallCount += 1;
        this.lastEventAtMs = atMs;
        break;
      case 'tool_result':
        this.lastEventAtMs = atMs;
        break;
      case 'note':
        if (chunk.text && !this.noteList.includes(chunk.text)) this.noteList.push(chunk.text);
        break;
      case 'terminal':
        this.terminalAtMs = atMs;
        this.lastEventAtMs = atMs;
        break;
      default:
        break;
    }
    if (carriesUsage) this.lastEventAtMs = atMs;
  }

  private markActivity(atMs: number): void {
    if (this.firstActivityAtMs === undefined) this.firstActivityAtMs = atMs;
    this.lastEventAtMs = atMs;
  }

  recordDelta(text: string, kind: 'text' | 'thinking', atMs: number): void {
    if (!text) return;
    if (this.readyAtMs === undefined) this.readyAtMs = atMs;
    this.markActivity(atMs);
    this.lastDeltaKind = kind;

    this.previewBuffer += text;
    if (this.previewBuffer.length > 240) this.previewBuffer = this.previewBuffer.slice(-240);

    if (kind === 'thinking') {
      this.thinkingCounter.push(text);
      return;
    }

    const tokens = Math.max(0, this.visibleCounter.push(text));
    this.textBuffer += text;
    if (this.firstVisibleAtMs === undefined) {
      this.firstVisibleAtMs = atMs;
      this.firstChunkTokens = tokens;
    }
    this.lastVisibleAtMs = atMs;
    this.samples.push({ atMs, tokens });
    if (tokens > this.maxChunkTokens) this.maxChunkTokens = tokens;
    this.advancePeak(atMs, tokens);
  }

  /** Window (atMs - 1s, atMs]; only counted once it lies fully inside the visible stream. */
  private advancePeak(atMs: number, tokens: number): void {
    this.windowTokens += tokens;
    const windowStart = atMs - PEAK_WINDOW_MS;
    while (
      this.windowStartIdx < this.samples.length &&
      this.samples[this.windowStartIdx].atMs <= windowStart
    ) {
      this.windowTokens -= this.samples[this.windowStartIdx].tokens;
      this.windowStartIdx += 1;
    }
    if (this.firstVisibleAtMs !== undefined && windowStart >= this.firstVisibleAtMs) {
      const rate = this.windowTokens / (PEAK_WINDOW_MS / 1000);
      if (rate > this.peak) this.peak = rate;
    }
  }

  /** Same 1-second window as the peak, evaluated at `nowMs`. Read-only: ticking never changes results. */
  computeCurrentTps(nowMs: number): number {
    if (this.firstVisibleAtMs === undefined) return 0;
    const sinceFirst = nowMs - this.firstVisibleAtMs;
    if (sinceFirst >= PEAK_WINDOW_MS) {
      const windowStart = nowMs - PEAK_WINDOW_MS;
      let tokens = 0;
      for (let i = this.samples.length - 1; i >= 0; i--) {
        const s = this.samples[i];
        if (s.atMs <= windowStart) break;
        if (s.atMs <= nowMs) tokens += s.tokens;
      }
      return round1(tokens / (PEAK_WINDOW_MS / 1000));
    }
    return this.computeAverageDecodeTps(nowMs);
  }

  computeAverageDecodeTps(nowMs: number): number {
    if (this.firstVisibleAtMs === undefined || this.samples.length < 2) return 0;
    const spanMs = nowMs - this.firstVisibleAtMs;
    if (spanMs < 250) return 0;
    return round1((this.visibleTokens - this.firstChunkTokens) / (spanMs / 1000));
  }

  private gapStats(): { jitterMs: number; medianGapMs: number; maxStallMs: number } | null {
    if (this.samples.length < 3) return null;
    const gaps: number[] = [];
    for (let i = 1; i < this.samples.length; i++) {
      gaps.push(Math.max(0, this.samples[i].atMs - this.samples[i - 1].atMs));
    }
    const mean = gaps.reduce((acc, g) => acc + g, 0) / gaps.length;
    const mad = gaps.reduce((acc, g) => acc + Math.abs(g - mean), 0) / gaps.length;
    return {
      jitterMs: round1(mad),
      medianGapMs: round1(median(gaps)),
      maxStallMs: Math.round(Math.max(...gaps)),
    };
  }

  private isStreaming(): boolean {
    if (this.declaredBuffered) return false;
    if (this.firstVisibleAtMs === undefined || this.lastVisibleAtMs === undefined) return false;
    if (this.samples.length < MIN_STREAM_CHUNKS) return false;
    if (this.lastVisibleAtMs - this.firstVisibleAtMs < MIN_STREAM_SPAN_MS) return false;
    const total = this.visibleTokens;
    if (total <= 0) return false;
    return this.maxChunkTokens <= total * MAX_SINGLE_CHUNK_SHARE;
  }

  toGaugeTick(nowMs: number): GaugeTick {
    const elapsedSec = ((nowMs - this.t0Ms) / 1000).toFixed(1);
    const model = this.reported.model;

    let stage: GaugeStage;
    let statusHint: string | undefined;
    if (this.firstVisibleAtMs !== undefined && this.lastDeltaKind !== 'thinking') {
      stage = 'streaming';
    } else if (this.firstActivityAtMs !== undefined) {
      stage = 'thinking';
      statusHint = `Model is thinking... (${elapsedSec}s)`;
    } else if (this.readyAtMs !== undefined) {
      stage = 'waiting';
      statusHint = `Connected${model ? ` (${model})` : ''} · waiting for first token... (${elapsedSec}s)`;
    } else {
      stage = 'booting';
      statusHint = `Starting... (${elapsedSec}s)`;
    }

    const gaps = this.gapStats();
    return {
      phase: this.phase,
      stage,
      elapsedMs: Math.max(0, Math.round(nowMs - this.t0Ms)),
      currentTps: this.computeCurrentTps(nowMs),
      averageTps: this.computeAverageDecodeTps(nowMs),
      peakTps: round1(this.peak),
      tokensGenerated: this.visibleTokens,
      thinkingTokens: this.thinkingTokens,
      readyMs: this.readyAtMs !== undefined ? this.sinceT0(this.readyAtMs) : undefined,
      ttftMs: this.firstVisibleAtMs !== undefined ? this.sinceT0(this.firstVisibleAtMs) : undefined,
      jitterMs: gaps?.jitterMs,
      previewText: sanitizePreviewText(this.previewBuffer),
      model,
      statusHint,
    };
  }

  private sinceT0(atMs: number): number {
    return Math.max(0, Math.round(atMs - this.t0Ms));
  }

  finalize(options: FinalizeOptions): PhaseResult {
    const endAtMs = this.terminalAtMs ?? this.lastEventAtMs ?? options.endMs;
    const durationMs = Math.max(1, this.sinceT0(endAtMs));

    const streaming = this.isStreaming();
    const outputTokens = this.visibleTokens;
    const hasVisible = this.firstVisibleAtMs !== undefined && this.lastVisibleAtMs !== undefined;
    const streamMs = hasVisible ? Math.round(this.lastVisibleAtMs! - this.firstVisibleAtMs!) : 0;

    // The streaming rule only makes sense for the long download answer; a one-word ping reply is
    // a single chunk by nature and still has a meaningful time-to-first-token unless the adapter
    // declared the route buffered.
    const ttftAllowed = this.phase === 'download' ? streaming : !this.declaredBuffered;
    const ttftMs = hasVisible && ttftAllowed ? Math.max(1, this.sinceT0(this.firstVisibleAtMs!)) : null;

    let decodeTps: number | null = null;
    let peakTps: number | null = null;
    if (streaming) {
      decodeTps = round1((outputTokens - this.firstChunkTokens) / (streamMs / 1000));
      peakTps = round1(Math.max(this.peak, decodeTps));
    }

    const e2eMs = hasVisible ? Math.max(1, this.lastVisibleAtMs! - this.t0Ms) : durationMs;
    const e2eTps = round1(outputTokens / (e2eMs / 1000));

    const gaps = streaming ? this.gapStats() : null;
    const text = this.textBuffer.trim();

    const result: PhaseResult = {
      phase: this.phase,
      durationMs,
      readyMs: this.readyAtMs !== undefined ? this.sinceT0(this.readyAtMs) : null,
      firstActivityMs:
        this.firstActivityAtMs !== undefined ? this.sinceT0(this.firstActivityAtMs) : null,
      ttftMs,
      streaming,
      isBuffered: !streaming,
      decodeTps,
      e2eTps,
      peakTps,
      outputTokens,
      thinkingTokens: this.thinkingTokens,
      outputWords: countWords(text),
      outputChars: text.length,
      chunkCount: this.samples.length,
      streamMs,
      jitterMs: gaps?.jitterMs ?? null,
      medianGapMs: gaps?.medianGapMs ?? null,
      maxStallMs: gaps?.maxStallMs ?? null,
      shortOutput:
        this.phase === 'download' &&
        (streamMs < SHORT_OUTPUT_MIN_STREAM_MS || outputTokens < SHORT_OUTPUT_MIN_TOKENS),
      promptTokens: options.promptTokens ?? 0,
      toolCalls: this.toolCallCount,
      responseText: text,
    };

    const r = this.reported;
    if (r.inputTokens !== undefined) result.reportedInputTokens = r.inputTokens;
    if (r.cachedInputTokens !== undefined) result.cachedInputTokens = r.cachedInputTokens;
    if (r.outputTokens !== undefined) result.reportedOutputTokens = r.outputTokens;
    if (r.reasoningTokens !== undefined) result.reportedReasoningTokens = r.reasoningTokens;
    if (r.promptEvalDurationMs !== undefined) result.promptEvalDurationMs = r.promptEvalDurationMs;
    if (r.evalDurationMs !== undefined) result.evalDurationMs = r.evalDurationMs;
    if (r.apiDurationMs !== undefined) result.apiDurationMs = r.apiDurationMs;
    if (r.costUsd !== undefined) result.costUsd = r.costUsd;
    if (r.model) result.model = r.model;
    if (options.verified !== undefined) result.verified = options.verified;
    if (this.noteList.length > 0) result.notes = [...this.noteList];
    if (Object.keys(this.extra).length > 0) result.extra = { ...this.extra };
    return result;
  }
}

export interface UploadPrefill {
  uploadOverheadMs: number | null;
  prefillTps: number | null;
  prefillReason?: string;
}

/**
 * Large-prompt cost (design section 3). A vendor-reported prompt-eval duration is used when
 * present (Ollama); otherwise the extra time-to-first-token over the ping phase is the only
 * figure that is not dominated by CLI boot and the harness's own cached context.
 */
export function computeUploadPrefill(
  upload: Pick<PhaseResult, 'ttftMs' | 'promptTokens' | 'promptEvalDurationMs' | 'verified'>,
  pingTtftMs: number | null | undefined
): UploadPrefill {
  const overhead =
    typeof upload.ttftMs === 'number' && typeof pingTtftMs === 'number'
      ? Math.round(upload.ttftMs - pingTtftMs)
      : null;

  if (upload.verified === false) {
    return { uploadOverheadMs: overhead, prefillTps: null, prefillReason: 'answer not verified' };
  }
  if (upload.promptTokens <= 0) {
    return { uploadOverheadMs: overhead, prefillTps: null, prefillReason: 'prompt size unknown' };
  }
  if (typeof upload.promptEvalDurationMs === 'number' && upload.promptEvalDurationMs > 10) {
    return {
      uploadOverheadMs: overhead,
      prefillTps: round1(upload.promptTokens / (upload.promptEvalDurationMs / 1000)),
    };
  }
  if (upload.ttftMs === null) {
    return { uploadOverheadMs: null, prefillTps: null, prefillReason: 'buffered target, no TTFT' };
  }
  if (overhead === null) {
    return { uploadOverheadMs: null, prefillTps: null, prefillReason: 'no ping TTFT to compare with' };
  }
  // A single ping and a single upload differ by a few hundred ms from run to run, so a
  // smaller overhead is noise and would produce an absurd rate.
  const noiseFloor = Math.max(MIN_PREFILL_OVERHEAD_MS, (pingTtftMs as number) * 0.25);
  if (overhead < noiseFloor) {
    return {
      uploadOverheadMs: overhead,
      prefillTps: null,
      prefillReason: 'overhead too small to measure against run-to-run noise',
    };
  }
  return {
    uploadOverheadMs: overhead,
    prefillTps: round1(upload.promptTokens / (overhead / 1000)),
  };
}
