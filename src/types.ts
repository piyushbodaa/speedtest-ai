export type TargetCategory = 'harness' | 'provider' | 'local' | 'demo' | 'custom';

export type BenchmarkMode = 'quick' | 'standard' | 'full';

export type PhaseId = 'ping' | 'download' | 'upload' | 'tool_loop';

export type SpeedGrade = 'HYPER' | 'TURBO' | 'CRUISING' | 'STEADY' | 'CRAWLING';

export interface TargetInfo {
  id: string;
  name: string;
  category: TargetCategory;
  available: boolean;
  version?: string;
  binaryPath?: string;
  defaultModel?: string;
  models?: string[];
  supportsToolLoop: boolean;
  reason?: string;
}

export interface AdapterStreamChunk {
  kind: 'init' | 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'usage' | 'meta';
  text?: string;
  toolName?: string;
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  promptEvalDurationMs?: number;
  evalDurationMs?: number;
  apiDurationMs?: number;
  costUsd?: number;
}

export interface AdapterInvokeRequest {
  phase: PhaseId;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  model?: string;
  cwd?: string;
  enableReadTool?: boolean;
  signal: AbortSignal;
}

export interface SpeedtestAdapter {
  id: string;
  name: string;
  category: TargetCategory;
  supportsToolLoop: boolean;
  defaultModel?: string;
  stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown>;
}

export interface GaugeTick {
  phase: PhaseId;
  elapsedMs: number;
  currentTps: number;
  averageTps: number;
  peakTps: number;
  tokensGenerated: number;
  ttftMs?: number;
  jitterMs?: number;
  previewText: string;
}

export interface PhaseResult {
  phase: PhaseId;
  durationMs: number;
  ttftMs: number;
  initMs?: number;
  decodeTps: number;
  e2eTps: number;
  peakTps: number;
  prefillTps?: number;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  thinkingTokens: number;
  tokenSource: 'reported' | 'estimated';
  isBuffered: boolean;
  medianItlMs: number;
  jitterMs: number;
  toolCalls: number;
  verified?: boolean;
  costUsd?: number;
  model?: string;
  responseText: string;
}

export interface SpeedtestSummary {
  pingMs: number;
  harnessBootMs?: number;
  jitterMs: number;
  medianItlMs: number;
  downloadDecodeTps: number;
  downloadE2eTps: number;
  downloadPeakTps: number;
  downloadOutputTokens: number;
  thinkingTokens: number;
  tokenSource: 'reported' | 'estimated';
  isBuffered: boolean;
  uploadPrefillTps?: number;
  uploadInputTokens?: number;
  uploadVerified?: boolean;
  toolLoopMs?: number;
  toolLoopVerified?: boolean;
  totalDurationMs: number;
  grade: SpeedGrade;
}

export interface SpeedtestResult {
  id: string;
  timestamp: string;
  targetId: string;
  targetName: string;
  category: TargetCategory;
  model: string;
  mode: BenchmarkMode;
  summary: SpeedtestSummary;
  phases: Partial<Record<PhaseId, PhaseResult>>;
}

export type SpeedtestEvent =
  | {
      type: 'run:start';
      timestamp: string;
      target: string;
      targetName: string;
      model?: string;
      mode: BenchmarkMode;
      phases: PhaseId[];
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
    };

export interface HistoricalDelta {
  sampleCount: number;
  avgDecodeTps: number;
  deltaPct: number;
}
