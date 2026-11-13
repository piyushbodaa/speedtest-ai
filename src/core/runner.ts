import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type {
  AdapterInvokeRequest,
  AdapterStreamChunk,
  BenchmarkMode,
  PhaseId,
  PhaseResult,
  SpeedtestAdapter,
  SpeedtestEvent,
  SpeedtestResult,
} from '../types.js';
import { appendHistory } from './history.js';
import { computeGrade, type ReportedUsage, RollingSpeedTracker } from './metrics.js';
import {
  buildDownloadPayload,
  buildPingPayload,
  buildToolLoopPayload,
  buildUploadPrefillPayload,
} from './payloads.js';

export interface RunSpeedtestOptions {
  adapter: SpeedtestAdapter;
  model?: string;
  mode?: BenchmarkMode;
  timeoutMs?: number;
  noHistory?: boolean;
  signal?: AbortSignal;
}

const PHASE_LABELS: Record<PhaseId, string> = {
  ping: 'Latency & Boot (Ping)',
  download: 'Sustained Output (Download TPS)',
  upload: 'Context Prefill (Upload TPS)',
  tool_loop: 'Agent Tool Loop (Read Probe)',
};

type QueueItem =
  | { kind: 'chunk'; chunk: AdapterStreamChunk; atMs: number }
  | { kind: 'tick'; atMs: number }
  | { kind: 'done'; atMs: number }
  | { kind: 'error'; error: Error };

function combineAbortSignals(timeoutMs: number, external?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Phase timed out after ${Math.round(timeoutMs / 1000)}s`));
  }, timeoutMs);

  const onExternalAbort = () => {
    controller.abort(external?.reason ?? new Error('Aborted'));
  };

  if (external) {
    if (external.aborted) {
      onExternalAbort();
    } else {
      external.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

async function* runSinglePhase(options: {
  adapter: SpeedtestAdapter;
  phase: PhaseId;
  model?: string;
  mode: BenchmarkMode;
  timeoutMs: number;
  signal?: AbortSignal;
}): AsyncGenerator<SpeedtestEvent, PhaseResult, unknown> {
  const { adapter, phase, model, mode, timeoutMs, signal: externalSignal } = options;
  const { signal, cleanup } = combineAbortSignals(timeoutMs, externalSignal);

  let probeDir: string | undefined;
  let prompt = '';
  let maxTokens = 1024;
  let enableReadTool = false;
  let estimatedInputTokens = 0;
  let expectedVerify: string | undefined;

  if (phase === 'ping') {
    const p = buildPingPayload();
    prompt = p.prompt;
    maxTokens = 32;
  } else if (phase === 'download') {
    const p = buildDownloadPayload(mode);
    prompt = p.prompt;
    maxTokens = mode === 'full' ? 1400 : 900;
  } else if (phase === 'upload') {
    const p = buildUploadPrefillPayload(mode);
    prompt = p.prompt;
    estimatedInputTokens = p.estimatedInputTokens;
    expectedVerify = p.expectedCode;
    maxTokens = 64;
  } else if (phase === 'tool_loop') {
    const p = buildToolLoopPayload();
    prompt = p.prompt;
    expectedVerify = p.expectedToken;
    enableReadTool = true;
    maxTokens = 128;
    probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'speedtest-ai-probe-'));
    await fs.writeFile(path.join(probeDir, p.filename), p.fileContent, 'utf8');
  }

  const requestStartMs = performance.now();
  const tracker = new RollingSpeedTracker(phase, requestStartMs);
  const reported: ReportedUsage = {};

  const req: AdapterInvokeRequest = {
    phase,
    prompt,
    maxTokens,
    model,
    cwd: probeDir,
    enableReadTool,
    signal,
  };

  const queue: QueueItem[] = [];
  let notifyWaiter: (() => void) | null = null;
  let finished = false;

  const pushItem = (item: QueueItem) => {
    queue.push(item);
    if (notifyWaiter) {
      const resolve = notifyWaiter;
      notifyWaiter = null;
      resolve();
    }
  };

  const tickInterval = setInterval(() => {
    if (!finished) {
      pushItem({ kind: 'tick', atMs: performance.now() });
    }
  }, 80);

  const pump = (async () => {
    try {
      for await (const chunk of adapter.stream(req)) {
        pushItem({ kind: 'chunk', chunk, atMs: performance.now() });
      }
      finished = true;
      pushItem({ kind: 'done', atMs: performance.now() });
    } catch (err) {
      finished = true;
      pushItem({
        kind: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  })();

  let completeMs = requestStartMs;

  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notifyWaiter = resolve;
        });
      }

      // Drain queued items cleanly; emit at most one gauge:tick per batch
      let shouldEmitTick = false;
      let latestTickAt = performance.now();
      let doneReached = false;

      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item.kind === 'error') {
          throw item.error;
        }
        if (item.kind === 'done') {
          completeMs = item.atMs;
          doneReached = true;
          continue;
        }
        if (item.kind === 'tick') {
          shouldEmitTick = true;
          latestTickAt = item.atMs;
          continue;
        }

        const { chunk, atMs } = item;
        latestTickAt = atMs;
        if (chunk.kind === 'init') {
          tracker.markInit(atMs);
          if (chunk.model) reported.model = chunk.model;
        } else if (chunk.kind === 'text' && chunk.text) {
          tracker.recordDelta(chunk.text, 'text', atMs);
          shouldEmitTick = true;
        } else if (chunk.kind === 'thinking' && chunk.text) {
          tracker.recordDelta(chunk.text, 'thinking', atMs);
          shouldEmitTick = true;
        } else if (chunk.kind === 'tool_call') {
          tracker.recordToolCall();
          shouldEmitTick = true;
        } else if (chunk.kind === 'usage') {
          if (chunk.model) reported.model = chunk.model;
          if (typeof chunk.inputTokens === 'number') reported.inputTokens = chunk.inputTokens;
          if (typeof chunk.cachedInputTokens === 'number') {
            reported.cachedInputTokens = chunk.cachedInputTokens;
          }
          if (typeof chunk.outputTokens === 'number') reported.outputTokens = chunk.outputTokens;
          if (typeof chunk.promptEvalDurationMs === 'number') {
            reported.promptEvalDurationMs = chunk.promptEvalDurationMs;
          }
          if (typeof chunk.evalDurationMs === 'number') {
            reported.evalDurationMs = chunk.evalDurationMs;
          }
          if (typeof chunk.apiDurationMs === 'number') {
            reported.apiDurationMs = chunk.apiDurationMs;
          }
          if (typeof chunk.costUsd === 'number') {
            reported.costUsd = chunk.costUsd;
          }
        }
      }

      if (shouldEmitTick) {
        yield { type: 'gauge:tick', tick: tracker.toGaugeTick(latestTickAt) };
      }

      if (doneReached) {
        break;
      }
    }

    await pump;
  } finally {
    clearInterval(tickInterval);
    cleanup();
    if (probeDir) {
      await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  let verified: boolean | undefined;
  if (expectedVerify) {
    verified = tracker.responseText.toUpperCase().includes(expectedVerify.toUpperCase());
  }

  return tracker.finalize(completeMs, reported, estimatedInputTokens, verified);
}

export async function* runSpeedtest(
  options: RunSpeedtestOptions
): AsyncGenerator<SpeedtestEvent, SpeedtestResult, unknown> {
  const mode: BenchmarkMode = options.mode ?? 'standard';
  const timeoutMs = options.timeoutMs ?? 90_000;
  const { adapter } = options;

  const phases: PhaseId[] =
    mode === 'quick'
      ? ['download']
      : ['ping', 'download', 'upload', ...(adapter.supportsToolLoop ? (['tool_loop'] as const) : [])];

  const runStartMs = performance.now();
  const timestamp = new Date().toISOString();

  yield {
    type: 'run:start',
    timestamp,
    target: adapter.id,
    targetName: adapter.name,
    model: options.model || adapter.defaultModel,
    mode,
    phases,
  };

  const phaseResults: Partial<Record<PhaseId, PhaseResult>> = {};
  let detectedModel = options.model || adapter.defaultModel || 'default';

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    yield {
      type: 'phase:start',
      phase,
      index: i + 1,
      total: phases.length,
      label: PHASE_LABELS[phase],
    };

    try {
      const phaseGen = runSinglePhase({
        adapter,
        phase,
        model: options.model,
        mode,
        timeoutMs,
        signal: options.signal,
      });

      while (true) {
        const next = await phaseGen.next();
        if (next.done) {
          const metrics = next.value;
          phaseResults[phase] = metrics;
          if (metrics.model) {
            detectedModel = metrics.model;
          }
          yield { type: 'phase:complete', phase, metrics };
          break;
        }
        yield next.value;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (phase === 'ping' || phase === 'download') {
        yield { type: 'run:error', phase, error: msg };
        throw err;
      }
      // Optional secondary phases (upload / tool_loop) degrade gracefully
      yield { type: 'phase:skip', phase, reason: msg };
    }
  }

  const download = phaseResults.download;
  if (!download) {
    throw new Error('Download phase did not produce a result.');
  }

  const ping = phaseResults.ping;
  const upload = phaseResults.upload;
  const toolLoop = phaseResults.tool_loop;

  const totalDurationMs = Math.max(1, Math.round(performance.now() - runStartMs));

  const result: SpeedtestResult = {
    id: crypto.randomUUID(),
    timestamp,
    targetId: adapter.id,
    targetName: adapter.name,
    category: adapter.category,
    model: detectedModel,
    mode,
    summary: {
      pingMs: ping ? ping.ttftMs : download.ttftMs,
      harnessBootMs: ping?.initMs ?? download.initMs,
      jitterMs: download.jitterMs,
      medianItlMs: download.medianItlMs,
      downloadDecodeTps: download.decodeTps,
      downloadE2eTps: download.e2eTps,
      downloadPeakTps: download.peakTps,
      downloadOutputTokens: download.outputTokens,
      thinkingTokens: download.thinkingTokens,
      tokenSource: download.tokenSource,
      isBuffered: download.isBuffered,
      uploadPrefillTps: upload?.prefillTps,
      uploadInputTokens: upload?.inputTokens,
      uploadVerified: upload?.verified,
      toolLoopMs: toolLoop?.durationMs,
      toolLoopVerified: toolLoop?.verified,
      totalDurationMs,
      grade: computeGrade(download.decodeTps),
    },
    phases: phaseResults,
  };

  if (!options.noHistory) {
    await appendHistory(result).catch(() => {});
  }

  yield { type: 'run:complete', result };
  return result;
}
