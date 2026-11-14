import type { PhaseResult, SpeedtestResult, SpeedtestSummary, TargetInfo } from '../../src/types.js';

type ResultOverrides = Omit<Partial<SpeedtestResult>, 'summary'> & { summary?: Partial<SpeedtestSummary> };

export function makePhase(overrides: Partial<PhaseResult> = {}): PhaseResult {
  return {
    phase: 'download',
    durationMs: 8200,
    readyMs: 70,
    firstActivityMs: 320,
    ttftMs: 340,
    streaming: true,
    isBuffered: false,
    decodeTps: 78.1,
    e2eTps: 70.2,
    peakTps: 85,
    outputTokens: 612,
    thinkingTokens: 0,
    outputWords: 600,
    outputChars: 3900,
    chunkCount: 300,
    streamMs: 7800,
    jitterMs: 3.2,
    medianGapMs: 12,
    maxStallMs: 41,
    shortOutput: false,
    promptTokens: 80,
    toolCalls: 0,
    responseText: '',
    ...overrides,
  };
}

/** A complete streaming result; pass `summary` / top-level overrides for the variant under test. */
export function makeResult(overrides: ResultOverrides = {}): SpeedtestResult {
  const { summary: summaryOverrides, ...rest } = overrides;
  const summary: SpeedtestSummary = {
    ttftMs: 340,
    readyMs: 70,
    firstActivityMs: 320,
    streaming: true,
    isBuffered: false,
    rankTps: 78.1,
    rankMetric: 'decode',
    grade: 'CRUISING',
    tokenUnit: 'normalized',
    downloadDecodeTps: 78.1,
    downloadE2eTps: 70.2,
    downloadPeakTps: 85,
    downloadTtftMs: 340,
    downloadDurationMs: 8200,
    downloadStreamMs: 7800,
    downloadOutputTokens: 612,
    downloadOutputWords: 600,
    thinkingTokens: 0,
    jitterMs: 3.2,
    medianGapMs: 12,
    maxStallMs: 41,
    shortOutput: false,
    totalDurationMs: 9100,
    ...summaryOverrides,
  };
  return {
    schemaVersion: 2,
    id: 'id-1',
    timestamp: '2026-01-02T03:04:05.000Z',
    targetId: 'claude',
    targetName: 'Claude Code',
    category: 'harness',
    tier: 'verified',
    isolation: 'lean',
    model: 'claude-test-model',
    mode: 'quick',
    runs: 1,
    summary,
    phases: { download: makePhase() },
    skipped: [],
    notes: [],
    ...rest,
  };
}

/** A buffered result: no TTFT, no decode rate, ranked on end-to-end tok/s. */
export function makeBufferedResult(overrides: ResultOverrides = {}): SpeedtestResult {
  const { summary, ...rest } = overrides;
  return makeResult({
    targetId: 'codex',
    targetName: 'OpenAI Codex CLI',
    model: 'gpt-test',
    phases: {
      download: makePhase({
        streaming: false,
        isBuffered: true,
        decodeTps: null,
        peakTps: null,
        ttftMs: null,
        jitterMs: null,
        medianGapMs: null,
        maxStallMs: null,
        e2eTps: 34.5,
      }),
    },
    ...rest,
    summary: {
      ttftMs: null,
      streaming: false,
      isBuffered: true,
      rankTps: 34.5,
      rankMetric: 'e2e',
      grade: 'STEADY',
      downloadDecodeTps: null,
      downloadE2eTps: 34.5,
      downloadPeakTps: null,
      downloadTtftMs: null,
      jitterMs: null,
      medianGapMs: null,
      maxStallMs: null,
      ...summary,
    },
  });
}

export function makeTarget(overrides: Partial<TargetInfo> = {}): TargetInfo {
  return {
    id: 'claude',
    name: 'Claude Code',
    category: 'harness',
    available: true,
    runnable: true,
    tier: 'verified',
    authState: 'ready',
    supportsToolLoop: true,
    reason: '2.1.0 (Claude Code)',
    ...overrides,
  };
}
