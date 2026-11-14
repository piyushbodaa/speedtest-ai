import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { settleChildren } from '../adapters/utils/spawn.js';
import type {
  AdapterInvokeRequest,
  AdapterStreamChunk,
  BenchmarkMode,
  PhaseId,
  PhaseResult,
  RunAggregate,
  RunErrorKind,
  RunSample,
  SkippedPhase,
  SpeedtestAdapter,
  SpeedtestEvent,
  SpeedtestResult,
  SpeedtestSummary,
} from '../types.js';
import {
  abortErrorFromSignal,
  InterruptedError,
  isInterruptedError,
  isPhaseTimeoutError,
  PhaseTimeoutError,
  TargetFailedError,
  toTypedError,
} from './errors.js';
import { appendHistory } from './history.js';
import {
  computeGrade,
  computeUploadPrefill,
  median,
  rankOf,
  RollingSpeedTracker,
  SLOW_START_MS,
} from './metrics.js';
import {
  buildDownloadPayload,
  buildPingPayload,
  buildToolLoopPayload,
  buildUploadPrefillPayload,
} from './payloads.js';
import { estimateTokens } from './tokenizer.js';

export const DEFAULT_PHASE_TIMEOUT_MS = 180_000;
export const MAX_RUNS = 5;

/** How long an aborted adapter gets to unwind (kill its child, remove temp dirs) before the runner moves on. */
const ABORT_UNWIND_GRACE_MS = 2500;
const TICK_INTERVAL_MS = 80;
const MIN_TICK_GAP_MS = 60;

export interface RunSpeedtestOptions {
  adapter: SpeedtestAdapter;
  /** Only when the user asked for a specific model; otherwise the target's own default is used. */
  model?: string;
  mode?: BenchmarkMode;
  /** Budget per phase. Default 180 s. */
  timeoutMs?: number;
  noHistory?: boolean;
  /**
   * Abort to stop the run. Abort with an InterruptedError for a user interrupt; any reason that is
   * not a PhaseTimeoutError is reported as an interrupt.
   */
  signal?: AbortSignal;
  /** Run harness CLIs with the user's full setup instead of the lean default. */
  asConfigured?: boolean;
  /**
   * Let the tool-loop phase start a CLI with its permission prompts turned off, where that is the
   * only way to run it unattended. Off by default: the phase is skipped for those CLIs.
   */
  allowPermissionBypass?: boolean;
}

export interface RunSpeedtestRepeatedOptions extends RunSpeedtestOptions {
  /** Download samples to take, 1..MAX_RUNS. Default 1. */
  runs?: number;
}

export const PHASE_LABELS: Record<PhaseId, string> = {
  ping: 'Time to first token (Ping)',
  download: 'Sustained output (Download)',
  upload: 'Large prompt (Upload)',
  tool_loop: 'Agent tool loop (Read probe)',
};

export function phasesForMode(mode: BenchmarkMode, adapter: Pick<SpeedtestAdapter, 'supportsToolLoop'>): PhaseId[] {
  if (mode === 'quick') return ['download'];
  return adapter.supportsToolLoop
    ? ['ping', 'download', 'upload', 'tool_loop']
    : ['ping', 'download', 'upload'];
}

type QueueItem =
  | { kind: 'chunk'; chunk: AdapterStreamChunk; atMs: number }
  | { kind: 'tick'; atMs: number }
  | { kind: 'done'; atMs: number }
  | { kind: 'abort' }
  | { kind: 'error'; error: unknown };

function linkAbortSignals(
  timeoutMs: number,
  phase: PhaseId,
  targetName: string,
  external?: AbortSignal
): { signal: AbortSignal; abort: (reason: Error) => void; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new PhaseTimeoutError(
        `${targetName}: ${phase} phase timed out after ${Math.round(timeoutMs / 1000)}s`,
        { timeoutMs }
      )
    );
  }, timeoutMs);

  const onExternalAbort = () => {
    if (external) controller.abort(abortErrorFromSignal(external));
  };
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

interface PhasePlan {
  prompt: string;
  maxTokens: number;
  enableReadTool: boolean;
  expectedVerify?: string;
  probe?: { filename: string; content: string };
}

function planPhase(phase: PhaseId, mode: BenchmarkMode): PhasePlan {
  if (phase === 'ping') {
    const p = buildPingPayload();
    return { prompt: p.prompt, maxTokens: 64, enableReadTool: false, expectedVerify: p.expected };
  }
  if (phase === 'download') {
    const p = buildDownloadPayload(mode);
    // Generous on purpose: vendor tokenizers spend up to ~2.3 tokens per word on this text.
    return { prompt: p.prompt, maxTokens: mode === 'full' ? 5000 : 2500, enableReadTool: false };
  }
  if (phase === 'upload') {
    const p = buildUploadPrefillPayload(mode);
    return { prompt: p.prompt, maxTokens: 128, enableReadTool: false, expectedVerify: p.expectedCode };
  }
  const p = buildToolLoopPayload();
  return {
    prompt: p.prompt,
    maxTokens: 256,
    enableReadTool: true,
    expectedVerify: p.expectedToken,
    probe: { filename: p.filename, content: p.fileContent },
  };
}

async function* runSinglePhase(options: {
  adapter: SpeedtestAdapter;
  phase: PhaseId;
  model?: string;
  mode: BenchmarkMode;
  timeoutMs: number;
  asConfigured?: boolean;
  signal?: AbortSignal;
}): AsyncGenerator<SpeedtestEvent, PhaseResult, unknown> {
  const { adapter, phase, model, mode, timeoutMs } = options;
  if (options.signal?.aborted) throw abortErrorFromSignal(options.signal);

  const plan = planPhase(phase, mode);
  let probeDir: string | undefined;
  if (plan.probe) {
    probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'speedtest-ai-probe-'));
    await fs.writeFile(path.join(probeDir, plan.probe.filename), plan.probe.content, 'utf8');
  }

  const { signal, abort, cleanup } = linkAbortSignals(timeoutMs, phase, adapter.name, options.signal);

  const req: AdapterInvokeRequest = {
    phase,
    prompt: plan.prompt,
    maxTokens: plan.maxTokens,
    model,
    cwd: probeDir,
    enableReadTool: plan.enableReadTool,
    asConfigured: options.asConfigured,
    timeoutMs,
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

  const onAbort = () => pushItem({ kind: 'abort' });
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  const tickInterval = setInterval(() => {
    if (!finished) pushItem({ kind: 'tick', atMs: performance.now() });
  }, TICK_INTERVAL_MS);

  // t0 for targets that never emit a `start` chunk (HTTP providers): the request goes out now.
  const tracker = new RollingSpeedTracker(phase, performance.now());
  const iterator = adapter.stream(req);

  const pump = (async () => {
    try {
      for await (const chunk of iterator) {
        pushItem({ kind: 'chunk', chunk, atMs: performance.now() });
      }
      pushItem({ kind: 'done', atMs: performance.now() });
    } catch (error) {
      pushItem({ kind: 'error', error });
    } finally {
      finished = true;
    }
  })();

  let endMs = tracker.startMs;
  let lastTickAt = -Infinity;
  let lastStage: string | undefined;

  try {
    reading: while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notifyWaiter = resolve;
        });
      }

      let shouldEmitTick = false;
      let latestAt = performance.now();
      let doneReached = false;

      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item.kind === 'abort') {
          // Let the adapter unwind off the clock, but never wait on it indefinitely.
          await Promise.race([
            pump,
            new Promise<void>((resolve) => setTimeout(resolve, ABORT_UNWIND_GRACE_MS).unref()),
          ]);
          if (!finished) void iterator.return(undefined).catch(() => {});
          throw abortErrorFromSignal(signal);
        }
        if (item.kind === 'error') {
          if (signal.aborted) throw abortErrorFromSignal(signal);
          throw toTypedError(item.error);
        }
        if (item.kind === 'done') {
          endMs = item.atMs;
          doneReached = true;
          continue;
        }
        if (item.kind === 'tick') {
          shouldEmitTick = true;
          latestAt = item.atMs;
          continue;
        }
        tracker.record(item.chunk, item.atMs);
        latestAt = item.atMs;
        shouldEmitTick = true;
      }

      if (doneReached) break reading;
      if (shouldEmitTick && !tracker.sawTerminal) {
        const tick = tracker.toGaugeTick(latestAt);
        // Chunks can arrive hundreds of times per second; a stage change is shown at once,
        // everything else at the timer's pace.
        if (tick.stage !== lastStage || latestAt - lastTickAt >= MIN_TICK_GAP_MS) {
          lastStage = tick.stage;
          lastTickAt = latestAt;
          yield { type: 'gauge:tick', tick };
        }
      }
    }

    // A cut-short run must never look like a result, whatever the adapter returned.
    if (signal.aborted) throw abortErrorFromSignal(signal);
  } finally {
    // A consumer that stops reading early (break, throw) lands here with the adapter still
    // running: stop it, or the child keeps generating with no time limit.
    if (!finished && !signal.aborted) abort(new InterruptedError('stopped before the phase finished'));
    finished = true;
    clearInterval(tickInterval);
    signal.removeEventListener('abort', onAbort);
    cleanup();
    await settleChildren();
    if (probeDir) {
      await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  let verified: boolean | undefined;
  if (plan.expectedVerify) {
    verified = tracker.responseText.toUpperCase().includes(plan.expectedVerify.toUpperCase());
  }

  return tracker.finalize({
    endMs,
    promptTokens: estimateTokens(plan.prompt),
    verified,
  });
}

function errorKind(err: unknown): RunErrorKind {
  if (isInterruptedError(err)) return 'interrupted';
  if (isPhaseTimeoutError(err)) return 'timeout';
  return 'failed';
}

function runErrorEvent(err: unknown, phase?: PhaseId): SpeedtestEvent {
  const typed = toTypedError(err);
  return {
    type: 'run:error',
    phase,
    error: typed.message,
    kind: errorKind(typed),
    failureKind: typed instanceof TargetFailedError ? typed.kind : undefined,
  };
}

/** Why an upload / tool_loop phase that returned normally still counts as failed. */
function secondaryPhaseFailure(metrics: PhaseResult): string | undefined {
  if (metrics.phase === 'upload' && metrics.verified === false) {
    return 'answer not verified: the expected marker was not in the reply';
  }
  if (metrics.phase === 'tool_loop') {
    if (metrics.verified === false) return 'answer not verified: the probe token was not in the reply';
    if (metrics.toolCalls < 1) return 'no tool call observed: the answer did not come from reading the file';
  }
  return undefined;
}

function pushUnique(list: string[], items: string[] | undefined): void {
  for (const item of items ?? []) {
    if (item && !list.includes(item)) list.push(item);
  }
}

interface SingleRunOutcome {
  result: SpeedtestResult;
}

async function* runOnce(
  options: RunSpeedtestOptions,
  plan: { mode: BenchmarkMode; phases: PhaseId[]; emitRunError: boolean }
): AsyncGenerator<SpeedtestEvent, SingleRunOutcome, unknown> {
  const { adapter } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
  const { mode, phases } = plan;

  const runStartMs = performance.now();
  const timestamp = new Date().toISOString();

  const phaseResults: Partial<Record<PhaseId, PhaseResult>> = {};
  const skipped: SkippedPhase[] = [];
  const notes: string[] = [];
  pushUnique(notes, adapter.notes);
  let detectedModel = options.model || adapter.defaultModel || 'default';
  let uploadVerified: boolean | undefined;
  let toolLoopVerified: boolean | undefined;
  let costUsd: number | undefined;

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    yield { type: 'phase:start', phase, index: i + 1, total: phases.length, label: PHASE_LABELS[phase] };

    if (phase === 'tool_loop' && adapter.toolLoopBypassesPermissions && !options.allowPermissionBypass) {
      const reason = `not run: it needs ${adapter.name} started with its permission prompts off. Pass --allow-permission-bypass to run it.`;
      skipped.push({ phase, reason });
      yield { type: 'phase:skip', phase, reason };
      continue;
    }

    let metrics: PhaseResult;
    try {
      const phaseGen = runSinglePhase({
        adapter,
        phase,
        model: options.model,
        mode,
        timeoutMs,
        asConfigured: options.asConfigured,
        signal: options.signal,
      });
      try {
        while (true) {
          const next = await phaseGen.next();
          if (next.done) {
            metrics = next.value;
            break;
          }
          yield next.value;
        }
      } finally {
        // No-op once the phase has finished; closes it when our own consumer stopped early.
        await phaseGen.return(undefined as never).catch(() => {});
      }
      if (phase === 'download' && metrics.outputTokens <= 0) {
        throw new TargetFailedError(`${adapter.name} produced no visible output`);
      }
    } catch (err) {
      const typed = toTypedError(err);
      const required = phase === 'ping' || phase === 'download';
      // An interrupt stops everything; a failed ping/download fails the run.
      if (required || isInterruptedError(typed)) {
        if (plan.emitRunError) yield runErrorEvent(typed, phase);
        throw typed;
      }
      skipped.push({ phase, reason: typed.message });
      yield { type: 'phase:skip', phase, reason: typed.message };
      continue;
    }

    if (metrics.model) detectedModel = metrics.model;
    pushUnique(notes, metrics.notes);
    if (typeof metrics.costUsd === 'number') costUsd = (costUsd ?? 0) + metrics.costUsd;

    if (phase === 'upload') {
      const prefill = computeUploadPrefill(metrics, phaseResults.ping?.ttftMs);
      metrics.uploadOverheadMs = prefill.uploadOverheadMs;
      metrics.prefillTps = prefill.prefillTps;
      if (prefill.prefillReason) metrics.prefillReason = prefill.prefillReason;
      uploadVerified = metrics.verified;
    }
    if (phase === 'tool_loop') {
      toolLoopVerified = metrics.verified === true && metrics.toolCalls >= 1;
    }

    const failure = secondaryPhaseFailure(metrics);
    if (failure) {
      skipped.push({ phase, reason: failure });
      yield { type: 'phase:skip', phase, reason: failure };
      continue;
    }

    phaseResults[phase] = metrics;
    yield { type: 'phase:complete', phase, metrics };
  }

  const download = phaseResults.download!;
  const ping = phaseResults.ping;

  // A long silent start is usually the model reasoning out of sight; say so when the CLI reports it.
  const hiddenReasoning = download.reportedReasoningTokens ?? 0;
  if (typeof download.ttftMs === 'number' && download.ttftMs >= SLOW_START_MS && hiddenReasoning >= 500) {
    pushUnique(notes, [
      `${adapter.name}: the model spent ${hiddenReasoning} hidden reasoning tokens before its first visible token (${(download.ttftMs / 1000).toFixed(0)}s wait); a lighter model or lower reasoning effort will start sooner`,
    ]);
  }
  const upload = phaseResults.upload;
  const toolLoop = phaseResults.tool_loop;
  const { rankTps, rankMetric } = rankOf(download);

  const summary: SpeedtestSummary = {
    // A buffered target has no time-to-first-token, whatever the one-chunk ping reply suggests.
    ttftMs: download.isBuffered ? null : (ping ? ping.ttftMs : download.ttftMs),
    readyMs: ping?.readyMs ?? download.readyMs,
    firstActivityMs: ping?.firstActivityMs ?? download.firstActivityMs,
    streaming: download.streaming,
    isBuffered: download.isBuffered,
    rankTps,
    rankMetric,
    grade: computeGrade(rankTps),
    tokenUnit: 'normalized',
    downloadDecodeTps: download.decodeTps,
    downloadE2eTps: download.e2eTps,
    downloadPeakTps: download.peakTps,
    downloadTtftMs: download.ttftMs,
    downloadDurationMs: download.durationMs,
    downloadStreamMs: download.streamMs,
    downloadOutputTokens: download.outputTokens,
    downloadOutputWords: download.outputWords,
    thinkingTokens: download.thinkingTokens,
    jitterMs: download.jitterMs,
    medianGapMs: download.medianGapMs,
    maxStallMs: download.maxStallMs,
    shortOutput: download.shortOutput,
    totalDurationMs: Math.max(1, Math.round(performance.now() - runStartMs)),
  };
  if (download.reportedInputTokens !== undefined) summary.reportedInputTokens = download.reportedInputTokens;
  if (download.cachedInputTokens !== undefined) summary.cachedInputTokens = download.cachedInputTokens;
  if (download.reportedOutputTokens !== undefined) summary.reportedOutputTokens = download.reportedOutputTokens;
  if (download.reportedReasoningTokens !== undefined) {
    summary.reportedReasoningTokens = download.reportedReasoningTokens;
  }
  if (upload) {
    summary.uploadTtftMs = upload.ttftMs;
    summary.uploadOverheadMs = upload.uploadOverheadMs ?? null;
    summary.uploadPrefillTps = upload.prefillTps ?? null;
    if (upload.prefillReason) summary.uploadPrefillReason = upload.prefillReason;
    summary.uploadPromptTokens = upload.promptTokens;
  }
  if (uploadVerified !== undefined) summary.uploadVerified = uploadVerified;
  if (toolLoop) {
    summary.toolLoopMs = toolLoop.durationMs;
    summary.toolLoopToolCalls = toolLoop.toolCalls;
  }
  if (toolLoopVerified !== undefined) summary.toolLoopVerified = toolLoopVerified;
  if (costUsd !== undefined) summary.costUsd = Math.round(costUsd * 1e6) / 1e6;

  const result: SpeedtestResult = {
    schemaVersion: 2,
    id: crypto.randomUUID(),
    timestamp,
    targetId: adapter.id,
    targetName: adapter.name,
    category: adapter.category,
    tier: adapter.tier,
    model: detectedModel,
    mode,
    runs: 1,
    summary,
    phases: phaseResults,
    skipped,
    notes,
  };
  if (adapter.category === 'harness') {
    // Only the verified adapters can strip MCP servers, hooks and plugins; the rest run the CLI as it is set up.
    result.isolation = options.asConfigured || adapter.tier !== 'verified' ? 'as-configured' : 'lean';
  }
  return { result };
}

/**
 * Runs one benchmark of `adapter` and yields progress events. Returns the result (also yielded as
 * `run:complete`). On failure it yields `run:error` and throws PhaseTimeoutError,
 * InterruptedError or TargetFailedError; nothing is saved to history in that case.
 */
export async function* runSpeedtest(
  options: RunSpeedtestOptions
): AsyncGenerator<SpeedtestEvent, SpeedtestResult, unknown> {
  return yield* runSpeedtestRepeated({ ...options, runs: 1 });
}

function sampleOf(run: number, result: SpeedtestResult): RunSample {
  const d = result.phases.download!;
  return {
    run,
    rankTps: result.summary.rankTps,
    rankMetric: result.summary.rankMetric,
    decodeTps: d.decodeTps,
    e2eTps: d.e2eTps,
    peakTps: d.peakTps,
    ttftMs: d.ttftMs,
    durationMs: d.durationMs,
    outputTokens: d.outputTokens,
    streaming: d.streaming,
    shortOutput: d.shortOutput,
  };
}

function medianOrNull(values: Array<number | null>, digits = 1): number | null {
  const present = values.filter((v): v is number => typeof v === 'number');
  // A metric that most samples could not produce is not reported for the aggregate either.
  if (present.length === 0 || present.length * 2 < values.length) return null;
  const factor = 10 ** digits;
  return Math.round(median(present) * factor) / factor;
}

/**
 * Folds N completed runs into one result: every download metric becomes the median over the
 * samples, with the min-max of decode TPS in `aggregate`. Ping / upload / tool-loop figures come
 * from the first run (the only one that executes those phases).
 */
export function aggregateRuns(
  results: SpeedtestResult[],
  requested: number,
  failed: Array<{ run: number; error: string }> = []
): SpeedtestResult {
  if (results.length === 0) throw new Error('aggregateRuns needs at least one result');
  const first = results[0];
  if (results.length === 1 && requested === 1) return first;

  const samples = results.map((r, i) => sampleOf(i + 1, r));
  const downloads = results.map((r) => r.phases.download!);
  const streamingCount = downloads.filter((d) => d.streaming).length;
  const streaming = streamingCount * 2 > downloads.length;

  const decodeValues = downloads.map((d) => d.decodeTps).filter((v): v is number => v !== null);
  const decodeTps = streaming ? medianOrNull(downloads.map((d) => d.decodeTps)) : null;
  const e2eTps = Math.round(median(downloads.map((d) => d.e2eTps)) * 10) / 10;
  const rankMetric = streaming && decodeTps !== null ? 'decode' : 'e2e';
  const rankTps = rankMetric === 'decode' ? decodeTps! : e2eTps;
  const rankValues = downloads.map((d) => (rankMetric === 'decode' ? d.decodeTps : d.e2eTps)).filter(
    (v): v is number => v !== null
  );
  const rankMin = Math.min(...rankValues);
  const rankMax = Math.max(...rankValues);

  const downloadTtftMs = streaming ? medianOrNull(downloads.map((d) => d.ttftMs), 0) : null;
  const s = first.summary;
  const summary: SpeedtestSummary = {
    ...s,
    ttftMs: !streaming ? null : first.phases.ping ? first.phases.ping.ttftMs : downloadTtftMs,
    streaming,
    isBuffered: !streaming,
    rankTps,
    rankMetric,
    grade: computeGrade(rankTps),
    downloadDecodeTps: decodeTps,
    downloadE2eTps: e2eTps,
    downloadPeakTps: streaming ? medianOrNull(downloads.map((d) => d.peakTps)) : null,
    downloadTtftMs,
    downloadDurationMs: Math.round(median(downloads.map((d) => d.durationMs))),
    downloadStreamMs: Math.round(median(downloads.map((d) => d.streamMs))),
    downloadOutputTokens: Math.round(median(downloads.map((d) => d.outputTokens))),
    downloadOutputWords: Math.round(median(downloads.map((d) => d.outputWords))),
    thinkingTokens: Math.round(median(downloads.map((d) => d.thinkingTokens))),
    jitterMs: streaming ? medianOrNull(downloads.map((d) => d.jitterMs)) : null,
    medianGapMs: streaming ? medianOrNull(downloads.map((d) => d.medianGapMs)) : null,
    maxStallMs: streaming ? medianOrNull(downloads.map((d) => d.maxStallMs), 0) : null,
    shortOutput: downloads.filter((d) => d.shortOutput).length * 2 > downloads.length,
    totalDurationMs: results.reduce((acc, r) => acc + r.summary.totalDurationMs, 0),
  };
  const costs = results.map((r) => r.summary.costUsd).filter((v): v is number => typeof v === 'number');
  if (costs.length > 0) summary.costUsd = Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6;

  const aggregate: RunAggregate = {
    requested,
    completed: results.length,
    decodeTpsMin: decodeValues.length > 0 ? Math.min(...decodeValues) : null,
    decodeTpsMax: decodeValues.length > 0 ? Math.max(...decodeValues) : null,
    rankTpsMin: rankMin,
    rankTpsMax: rankMax,
    spreadPct: rankTps > 0 ? Math.round(((rankMax - rankMin) / rankTps) * 1000) / 10 : 0,
    samples,
    failed,
  };

  const notes = [...first.notes];
  for (const r of results) pushUnique(notes, r.notes);
  for (const f of failed) pushUnique(notes, [`run ${f.run} of ${requested} failed: ${f.error}`]);

  // The sample closest to the median stands in for the per-phase detail of the download.
  const metricOf = (r: SpeedtestResult): number => {
    const d = r.phases.download!;
    return rankMetric === 'decode' ? (d.decodeTps ?? Number.NaN) : d.e2eTps;
  };
  const sameKind = results.filter((r) => r.phases.download!.streaming === streaming && Number.isFinite(metricOf(r)));
  const representative = (sameKind.length > 0 ? sameKind : results).reduce((best, r) =>
    Math.abs(metricOf(r) - rankTps) < Math.abs(metricOf(best) - rankTps) ? r : best
  );

  return {
    ...first,
    id: crypto.randomUUID(),
    runs: results.length,
    aggregate,
    summary,
    phases: { ...first.phases, download: representative.phases.download },
    notes,
  };
}

/**
 * `--runs N`: run 1 executes every phase of the mode; runs 2..N repeat only the download phase
 * (the noisy one, and the only one behind the ranked figure), which keeps the token cost down.
 * With N = 1 this is exactly `runSpeedtest`.
 *
 * Events: one `run:start` (with `runs`), then for N > 1 a `repeat:start` / `repeat:complete` pair
 * around each sample, the usual phase events, and one final `run:complete` with the aggregate.
 * A failing later sample stops the repetition and is listed in `aggregate.failed`; a failing
 * first sample, or an interrupt at any point, throws.
 */
export async function* runSpeedtestRepeated(
  options: RunSpeedtestRepeatedOptions
): AsyncGenerator<SpeedtestEvent, SpeedtestResult, unknown> {
  const requested = Math.max(1, Math.min(MAX_RUNS, Math.floor(options.runs ?? 1)));
  const mode: BenchmarkMode = options.mode ?? 'standard';
  const firstPhases = phasesForMode(mode, options.adapter);

  const results: SpeedtestResult[] = [];
  const failed: Array<{ run: number; error: string }> = [];

  yield {
    type: 'run:start',
    timestamp: new Date().toISOString(),
    target: options.adapter.id,
    targetName: options.adapter.name,
    model: options.model || options.adapter.defaultModel,
    mode,
    phases: firstPhases,
    runs: requested,
  };

  for (let run = 1; run <= requested; run++) {
    if (requested > 1) yield { type: 'repeat:start', run, of: requested };
    try {
      const outcome = yield* runOnce(options, {
        mode,
        phases: run === 1 ? firstPhases : ['download'],
        emitRunError: run === 1,
      });
      results.push(outcome.result);
      if (requested > 1) {
        yield { type: 'repeat:complete', run, of: requested, result: outcome.result };
      }
    } catch (err) {
      const typed = toTypedError(err);
      if (run === 1) throw typed;
      if (isInterruptedError(typed)) {
        yield runErrorEvent(typed, 'download');
        throw typed;
      }
      failed.push({ run, error: typed.message });
      yield { type: 'phase:skip', phase: 'download', reason: `run ${run} of ${requested}: ${typed.message}` };
      break;
    }
  }

  if (options.signal?.aborted) {
    const err = abortErrorFromSignal(options.signal);
    yield runErrorEvent(err);
    throw err;
  }

  const result = aggregateRuns(results, requested, failed);
  if (!options.noHistory) {
    await appendHistory(result).catch(() => {});
  }

  yield { type: 'run:complete', result };
  return result;
}

export { InterruptedError, PhaseTimeoutError, TargetFailedError };
