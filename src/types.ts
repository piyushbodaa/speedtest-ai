import type { FailureKind } from './core/errors.js';

export type { FailureKind } from './core/errors.js';

export const RESULT_SCHEMA_VERSION = 2;

export type TargetCategory = 'harness' | 'provider' | 'local' | 'demo' | 'custom';

/** `verified` = exercised against the real CLI; `experimental` = built from documentation only. */
export type SupportTier = 'verified' | 'experimental';

/** `logged_out` is only ever claimed from a verified cheap probe; otherwise `ready` or `unknown`. */
export type AuthState = 'ready' | 'logged_out' | 'unknown';

/** `lean` keeps auth and the user's model but drops MCP servers, hooks, plugins, skills, project context. */
export type IsolationMode = 'lean' | 'as-configured';

export type BenchmarkMode = 'quick' | 'standard' | 'full';

export type PhaseId = 'ping' | 'download' | 'upload' | 'tool_loop';

export type SpeedGrade = 'HYPER' | 'TURBO' | 'CRUISING' | 'STEADY' | 'CRAWLING';

/** Which rate a result is ranked and graded on: decode TPS when streaming is valid, else end-to-end TPS. */
export type RankMetric = 'decode' | 'e2e';

export interface TargetInfo {
  id: string;
  name: string;
  category: TargetCategory;
  /** The binary (or endpoint / API key) was found. */
  available: boolean;
  /** Available AND the capability probe confirmed the flags the adapter needs. */
  runnable: boolean;
  tier: SupportTier;
  authState: AuthState;
  version?: string;
  binaryPath?: string;
  defaultModel?: string;
  models?: string[];
  supportsToolLoop: boolean;
  /** Why the target is unavailable or not runnable ("installed, not supported yet", ...). */
  reason?: string;
}

/**
 * One item of an adapter's stream. The runner stamps each chunk with its arrival time; adapters
 * never report timestamps.
 *
 * - `start`     the child process was spawned (or the HTTP request was sent). Defines t0. Emitted by
 *               the shared harness runner; an adapter that respawns (fallback route) emits it again.
 * - `init`      the CLI announced itself; may carry `model`.
 * - `meta`      any other event worth nothing but "the CLI is alive"; may carry `model`,
 *               `buffered`, `extra`. The first chunk of any kind after `start` sets `readyMs`.
 * - `activity`  the model began responding without visible text (hidden thinking, message_start).
 * - `thinking`  a streamed reasoning delta (`text`).
 * - `text`      a VISIBLE answer delta (`text`).
 * - `tool_call` / `tool_result`  agent tool use (`toolName`).
 * - `usage`     vendor-reported usage; fields may also ride on `init`, `meta` or `terminal`.
 * - `note`      a human-readable caveat to attach to the result (`text`).
 * - `terminal`  the adapter's declared success event. Stops the clock. Nothing is read after it.
 */
export interface AdapterStreamChunk {
  kind:
    | 'start'
    | 'init'
    | 'meta'
    | 'activity'
    | 'thinking'
    | 'text'
    | 'tool_call'
    | 'tool_result'
    | 'usage'
    | 'note'
    | 'terminal';
  text?: string;
  toolName?: string;
  /** The real model name the CLI reports. Later values win. */
  model?: string;
  /** Vendor-reported prompt tokens for the whole request, INCLUDING cached tokens. */
  inputTokens?: number;
  /** Vendor-reported part of `inputTokens` that was served from cache. */
  cachedInputTokens?: number;
  /** Vendor-reported output tokens, as the vendor counts them (may include reasoning). */
  outputTokens?: number;
  /** Vendor-reported reasoning / thinking tokens. */
  reasoningTokens?: number;
  promptEvalDurationMs?: number;
  evalDurationMs?: number;
  apiDurationMs?: number;
  costUsd?: number;
  /** Set to true when the route cannot stream at all (e.g. `codex exec`): no TTFT, no decode TPS. */
  buffered?: boolean;
  /** Adapter-specific informational values copied to `PhaseResult.extra` (never ranked). */
  extra?: Record<string, number | string | boolean>;
}

export interface AdapterInvokeRequest {
  phase: PhaseId;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  /** Only set when the user passed -m; otherwise the CLI's own configured model must be used. */
  model?: string;
  /** Probe directory for the tool_loop phase. */
  cwd?: string;
  enableReadTool?: boolean;
  /** Run the CLI with the user's full setup (MCP, hooks, plugins, ...) instead of the lean default. */
  asConfigured?: boolean;
  /** The phase budget, for CLIs that take their own timeout flag. The runner enforces it regardless. */
  timeoutMs?: number;
  /** Aborted with a PhaseTimeoutError or InterruptedError as reason. */
  signal: AbortSignal;
}

export interface SpeedtestAdapter {
  id: string;
  name: string;
  category: TargetCategory;
  tier: SupportTier;
  supportsToolLoop: boolean;
  /**
   * The tool-loop phase can only run unattended if this CLI is started with a flag that turns its
   * permission prompts off. Such a phase is skipped unless the user asks for it.
   */
  toolLoopBypassesPermissions?: boolean;
  defaultModel?: string;
  /** Static caveats attached to every result of this adapter (per-run ones go through `note` chunks). */
  notes?: string[];
  /**
   * Must throw (TargetFailedError preferred) unless the run completed successfully, and must throw
   * the signal's reason when `req.signal` aborts. Returning normally means "complete answer".
   */
  stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown>;
}

export type GaugeStage = 'booting' | 'waiting' | 'thinking' | 'streaming';

export interface GaugeTick {
  phase: PhaseId;
  stage: GaugeStage;
  elapsedMs: number;
  /** Normalized visible tokens per second over the last full second (same window as `peakTps`). */
  currentTps: number;
  /** Running decode rate: visible tokens after the first chunk / time since the first chunk. */
  averageTps: number;
  /** Best full 1-second window so far; 0 until one second of visible streaming has elapsed. */
  peakTps: number;
  /** Normalized visible tokens so far. */
  tokensGenerated: number;
  /** Normalized streamed thinking tokens so far. */
  thinkingTokens: number;
  readyMs?: number;
  ttftMs?: number;
  jitterMs?: number;
  previewText: string;
  model?: string;
  statusHint?: string;
}

export interface PhaseResult {
  phase: PhaseId;
  /** t0 (spawn / request sent) to the terminal event, or to the last content/usage event. */
  durationMs: number;
  /** t0 to the first event of any kind from the target. Informational ("CLI ready"). */
  readyMs: number | null;
  /** t0 to the first thinking or text delta (or `activity` marker). */
  firstActivityMs: number | null;
  /** t0 to the first VISIBLE text delta. Null when the target is buffered. */
  ttftMs: number | null;
  /** The visible stream was genuinely incremental (>= 8 chunks, >= 1000 ms, no chunk > 50%). */
  streaming: boolean;
  /** Always `!streaming`. */
  isBuffered: boolean;
  /** Normalized visible tokens after the first chunk / (last - first visible delta). Null when buffered. */
  decodeTps: number | null;
  /** Normalized visible tokens / (last visible delta - t0). */
  e2eTps: number;
  /** Best full 1-second window, normalized tokens. Null when buffered. */
  peakTps: number | null;
  /** NORMALIZED visible tokens (local estimator on the visible text; identical for every target). */
  outputTokens: number;
  /** NORMALIZED tokens of streamed thinking text; never added to `outputTokens`. */
  thinkingTokens: number;
  outputWords: number;
  outputChars: number;
  /** Number of visible text deltas. */
  chunkCount: number;
  /** Last visible delta - first visible delta. */
  streamMs: number;
  /** Mean absolute deviation of the gaps between visible chunks. Null when buffered. */
  jitterMs: number | null;
  /** Median gap between visible chunks. Null when buffered. */
  medianGapMs: number | null;
  /** Longest gap between visible chunks. Null when buffered. */
  maxStallMs: number | null;
  /** Download only: the visible stream lasted < 2 s or produced < 150 normalized tokens. */
  shortOutput: boolean;
  /** NORMALIZED tokens of the prompt this tool sent. */
  promptTokens: number;
  /** Vendor counts, shown for information only and never mixed into a rate. */
  reportedInputTokens?: number;
  cachedInputTokens?: number;
  reportedOutputTokens?: number;
  reportedReasoningTokens?: number;
  promptEvalDurationMs?: number;
  evalDurationMs?: number;
  apiDurationMs?: number;
  toolCalls: number;
  /** Upload / tool_loop / ping: the expected marker was found in the answer. */
  verified?: boolean;
  /** Upload only: uploadTtft - pingTtft. */
  uploadOverheadMs?: number | null;
  /** Upload only: normalized prompt tokens per second of prefill. Null with `prefillReason` when not derivable. */
  prefillTps?: number | null;
  prefillReason?: string;
  costUsd?: number;
  model?: string;
  notes?: string[];
  extra?: Record<string, number | string | boolean>;
  responseText: string;
}

export interface SpeedtestSummary {
  /** Headline "PING (TTFT)": ping-phase TTFT (download TTFT in quick mode). Null = "n/a (buffered)". */
  ttftMs: number | null;
  readyMs: number | null;
  firstActivityMs: number | null;
  streaming: boolean;
  isBuffered: boolean;
  /** The figure the result is ranked and graded on. */
  rankTps: number;
  rankMetric: RankMetric;
  grade: SpeedGrade;
  tokenUnit: 'normalized';
  downloadDecodeTps: number | null;
  downloadE2eTps: number;
  downloadPeakTps: number | null;
  downloadTtftMs: number | null;
  downloadDurationMs: number;
  downloadStreamMs: number;
  downloadOutputTokens: number;
  downloadOutputWords: number;
  thinkingTokens: number;
  jitterMs: number | null;
  medianGapMs: number | null;
  maxStallMs: number | null;
  shortOutput: boolean;
  reportedInputTokens?: number;
  cachedInputTokens?: number;
  reportedOutputTokens?: number;
  reportedReasoningTokens?: number;
  uploadTtftMs?: number | null;
  uploadOverheadMs?: number | null;
  uploadPrefillTps?: number | null;
  uploadPrefillReason?: string;
  uploadPromptTokens?: number;
  /** false when the upload phase ran but its answer was wrong (the phase is then listed in `skipped`). */
  uploadVerified?: boolean;
  toolLoopMs?: number;
  toolLoopToolCalls?: number;
  /** false when the tool loop ran but the token was wrong or no tool call was observed. */
  toolLoopVerified?: boolean;
  /** Sum of the vendor-reported cost over every phase that reported one. */
  costUsd?: number;
  totalDurationMs: number;
}

export interface SkippedPhase {
  phase: PhaseId;
  reason: string;
}

/** One download measurement inside a `--runs N` aggregation. */
export interface RunSample {
  run: number;
  rankTps: number;
  rankMetric: RankMetric;
  decodeTps: number | null;
  e2eTps: number;
  peakTps: number | null;
  ttftMs: number | null;
  durationMs: number;
  outputTokens: number;
  streaming: boolean;
  shortOutput: boolean;
}

export interface RunAggregate {
  /** Runs requested with --runs. */
  requested: number;
  /** Runs that completed and are included in the medians. */
  completed: number;
  decodeTpsMin: number | null;
  decodeTpsMax: number | null;
  rankTpsMin: number;
  rankTpsMax: number;
  /** (max - min) / median of the rank metric, in percent. */
  spreadPct: number;
  samples: RunSample[];
  failed: Array<{ run: number; error: string }>;
}

export interface SpeedtestResult {
  schemaVersion: 2;
  id: string;
  timestamp: string;
  targetId: string;
  targetName: string;
  category: TargetCategory;
  tier: SupportTier;
  /** Harness targets only. */
  isolation?: IsolationMode;
  model: string;
  mode: BenchmarkMode;
  /** Completed download samples behind this result (1 = single sample). */
  runs: number;
  /** Present when `runs > 1`; the summary then holds per-metric medians. */
  aggregate?: RunAggregate;
  summary: SpeedtestSummary;
  phases: Partial<Record<PhaseId, PhaseResult>>;
  /** Upload / tool_loop phases that failed or were skipped, with the reason. */
  skipped: SkippedPhase[];
  notes: string[];
}

export type RunErrorKind = 'timeout' | 'interrupted' | 'failed';

export type SpeedtestEvent =
  | {
      type: 'run:start';
      timestamp: string;
      target: string;
      targetName: string;
      model?: string;
      mode: BenchmarkMode;
      phases: PhaseId[];
      /** Total download samples that will be taken (--runs). */
      runs: number;
    }
  | {
      /** Only emitted when runs > 1: sample `run` of `of` is starting. */
      type: 'repeat:start';
      run: number;
      of: number;
    }
  | {
      /** Only emitted when runs > 1: sample `run` finished; `result` is that single run. */
      type: 'repeat:complete';
      run: number;
      of: number;
      result: SpeedtestResult;
    }
  | {
      type: 'phase:start';
      phase: PhaseId;
      index: number;
      total: number;
      label: string;
    }
  | {
      type: 'gauge:tick';
      tick: GaugeTick;
    }
  | {
      type: 'phase:complete';
      phase: PhaseId;
      metrics: PhaseResult;
    }
  | {
      type: 'phase:skip';
      phase: PhaseId;
      reason: string;
    }
  | {
      type: 'run:complete';
      result: SpeedtestResult;
    }
  | {
      type: 'run:error';
      phase?: PhaseId;
      error: string;
      kind: RunErrorKind;
      failureKind?: FailureKind;
    };

export interface HistoricalDelta {
  sampleCount: number;
  avgDecodeTps: number;
  deltaPct: number;
}
