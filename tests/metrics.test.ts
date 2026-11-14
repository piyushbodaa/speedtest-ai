import { describe, expect, it } from 'vitest';
import {
  compareResultsByRank,
  computeGrade,
  computeUploadPrefill,
  median,
  rankOf,
  RollingSpeedTracker,
} from '../src/core/metrics.js';
import { buildDownloadPayload, buildUploadPrefillPayload } from '../src/core/payloads.js';
import { countWords, estimateTokens, StreamTokenCounter } from '../src/core/tokenizer.js';
import type { SpeedtestResult } from '../src/types.js';

const PROSE =
  '1. Packet-switched networks divide application payloads into bounded datagrams carrying source and destination routing headers. ' +
  '2. Congestion control loops infer bottleneck queue depth from round-trip delay inflation and explicit packet drops, ' +
  "so the sender's window doesn't overrun the slowest link on the path.";

describe('estimateTokens (normalized tokens)', () => {
  it('returns 0 for empty text and at least 1 otherwise', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hi')).toBe(1);
    expect(estimateTokens('hello world')).toBe(2);
  });

  it('counts a long word as one token (no subword split)', () => {
    expect(estimateTokens('supercalifragilisticexpialidocious')).toBe(1);
    expect(estimateTokens('internationalization standardization')).toBe(2);
  });

  it('stays near 1.2-1.6 tokens per word on English prose', () => {
    const ratio = estimateTokens(PROSE) / countWords(PROSE);
    expect(ratio).toBeGreaterThan(1.1);
    expect(ratio).toBeLessThan(1.6);
  });

  it('handles digits, punctuation and non-ASCII text', () => {
    expect(estimateTokens('1234567')).toBe(3);
    expect(estimateTokens('a, b.')).toBe(4);
    expect(estimateTokens('你好世界测试')).toBeGreaterThanOrEqual(3);
  });
});

describe('StreamTokenCounter', () => {
  it('matches the whole-text estimate for any chunking', () => {
    const whole = estimateTokens(PROSE);
    for (const size of [1, 2, 3, 5, 7, 13, 40, 1000]) {
      const counter = new StreamTokenCounter();
      let sum = 0;
      for (let i = 0; i < PROSE.length; i += size) {
        const added = counter.push(PROSE.slice(i, i + size));
        expect(added).toBeGreaterThanOrEqual(0);
        sum += added;
      }
      expect(counter.total).toBe(whole);
      expect(sum).toBe(whole);
    }
  });

  it('does not count a word twice when it is split across deltas', () => {
    const counter = new StreamTokenCounter();
    expect(counter.push('conges')).toBe(1);
    expect(counter.push('tion')).toBe(0);
    expect(counter.push(' control')).toBe(1);
    expect(counter.total).toBe(2);
  });
});

/** Feeds `count` visible chunks of `tokensEach` words, `gapMs` apart, starting at t0 + firstAt. */
function streamed(options: {
  phase?: 'download' | 'ping';
  t0?: number;
  firstAt: number;
  count: number;
  gapMs: number;
  wordsEach?: number;
}): RollingSpeedTracker {
  const t0 = options.t0 ?? 1000;
  const tracker = new RollingSpeedTracker(options.phase ?? 'download', t0);
  for (let i = 0; i < options.count; i++) {
    tracker.record(
      { kind: 'text', text: ' word'.repeat(options.wordsEach ?? 1) },
      t0 + options.firstAt + i * options.gapMs
    );
  }
  return tracker;
}

describe('RollingSpeedTracker timing model', () => {
  it('measures ready, first activity and TTFT from t0 and stops the clock at the terminal event', () => {
    const t0 = 5000;
    const tracker = new RollingSpeedTracker('download', t0);
    tracker.record({ kind: 'init', model: 'm-1' }, t0 + 120);
    tracker.record({ kind: 'activity' }, t0 + 400);
    tracker.record({ kind: 'thinking', text: 'let me think about this' }, t0 + 450);
    for (let i = 0; i < 21; i++) {
      tracker.record({ kind: 'text', text: ' alpha beta' }, t0 + 1000 + i * 100);
    }
    tracker.record({ kind: 'terminal', outputTokens: 999, reasoningTokens: 5, inputTokens: 18000, cachedInputTokens: 13000 }, t0 + 3050);

    const res = tracker.finalize({ endMs: t0 + 9000, promptTokens: 44 });
    expect(res.readyMs).toBe(120);
    expect(res.firstActivityMs).toBe(400);
    expect(res.ttftMs).toBe(1000);
    // Process teardown (endMs) is not part of the duration.
    expect(res.durationMs).toBe(3050);
    expect(res.streaming).toBe(true);
    expect(res.isBuffered).toBe(false);
    expect(res.model).toBe('m-1');

    // 42 visible normalized tokens; 40 after the first chunk over 2.0 s.
    expect(res.outputTokens).toBe(42);
    expect(res.decodeTps).toBe(20);
    // 42 tokens / 3.0 s (t0 -> last visible delta).
    expect(res.e2eTps).toBe(14);
    expect(res.thinkingTokens).toBe(5);

    // Vendor counts are carried separately and never used for a rate.
    expect(res.reportedOutputTokens).toBe(999);
    expect(res.reportedReasoningTokens).toBe(5);
    expect(res.reportedInputTokens).toBe(18000);
    expect(res.cachedInputTokens).toBe(13000);
    expect(res.promptTokens).toBe(44);
  });

  it('a start chunk moves t0 to the spawn moment', () => {
    const tracker = new RollingSpeedTracker('ping', 1000);
    tracker.record({ kind: 'start' }, 1040);
    tracker.record({ kind: 'meta' }, 1140);
    tracker.record({ kind: 'text', text: 'PONG' }, 1540);
    tracker.record({ kind: 'terminal' }, 1560);
    const res = tracker.finalize({ endMs: 3000 });
    expect(res.readyMs).toBe(100);
    expect(res.ttftMs).toBe(500);
    expect(res.durationMs).toBe(520);
  });

  it('a second start chunk (fallback respawn) restarts the clock only before any content', () => {
    const tracker = new RollingSpeedTracker('download', 0);
    tracker.record({ kind: 'start' }, 10);
    tracker.record({ kind: 'meta' }, 50);
    tracker.record({ kind: 'start' }, 10_000);
    tracker.record({ kind: 'text', text: 'answer' }, 10_800);
    tracker.record({ kind: 'start' }, 11_000);
    const res = tracker.finalize({ endMs: 12_000 });
    expect(res.readyMs).toBe(800);
    expect(res.e2eTps).toBe(1.3);
    expect(res.durationMs).toBe(800);
  });

  it('ignores everything after the terminal event', () => {
    const tracker = streamed({ firstAt: 100, count: 20, gapMs: 100 });
    tracker.record({ kind: 'terminal' }, 1000 + 2100);
    tracker.record({ kind: 'text', text: ' late late late' }, 1000 + 5000);
    const res = tracker.finalize({ endMs: 99_999 });
    expect(res.outputTokens).toBe(20);
    expect(res.durationMs).toBe(2100);
  });

  it('falls back to the last content event, then to endMs, when there is no terminal event', () => {
    const withContent = streamed({ firstAt: 100, count: 3, gapMs: 100 });
    expect(withContent.finalize({ endMs: 99_999 }).durationMs).toBe(300);
    const silent = new RollingSpeedTracker('download', 1000);
    expect(silent.finalize({ endMs: 1750 }).durationMs).toBe(750);
  });

  it('a ping reply is one chunk yet still has a TTFT; a declared-buffered route has none', () => {
    const ping = streamed({ phase: 'ping', firstAt: 640, count: 1, gapMs: 0 });
    const res = ping.finalize({ endMs: 2000 });
    expect(res.ttftMs).toBe(640);
    expect(res.streaming).toBe(false);
    expect(res.decodeTps).toBeNull();

    const buffered = new RollingSpeedTracker('ping', 1000);
    buffered.record({ kind: 'meta', buffered: true }, 1100);
    buffered.record({ kind: 'text', text: 'PONG' }, 1640);
    expect(buffered.finalize({ endMs: 2000 }).ttftMs).toBeNull();
  });
});

describe('streaming validity rule', () => {
  it('accepts >= 8 chunks over >= 1000 ms with no dominant chunk', () => {
    const res = streamed({ firstAt: 300, count: 11, gapMs: 100 }).finalize({ endMs: 0 });
    expect(res.streaming).toBe(true);
    expect(res.chunkCount).toBe(11);
    expect(res.streamMs).toBe(1000);
    expect(res.decodeTps).toBe(10);
    expect(res.ttftMs).toBe(300);
  });

  it('rejects fewer than 8 chunks', () => {
    const res = streamed({ firstAt: 300, count: 7, gapMs: 400 }).finalize({ endMs: 0 });
    expect(res.streaming).toBe(false);
    expect(res.isBuffered).toBe(true);
    expect(res.decodeTps).toBeNull();
    expect(res.peakTps).toBeNull();
    expect(res.ttftMs).toBeNull();
    expect(res.jitterMs).toBeNull();
    expect(res.medianGapMs).toBeNull();
    expect(res.maxStallMs).toBeNull();
  });

  it('rejects a span under 1000 ms (fast flush after hidden reasoning)', () => {
    const res = streamed({ firstAt: 26_000, count: 28, gapMs: 30, wordsEach: 12 }).finalize({ endMs: 0 });
    expect(res.streamMs).toBe(810);
    expect(res.streaming).toBe(false);
    expect(res.decodeTps).toBeNull();
    // 336 tokens over 26.81 s: the honest figure for a burst.
    expect(res.e2eTps).toBe(12.5);
  });

  it('rejects a stream where one chunk carries more than half of the tokens', () => {
    const tracker = streamed({ firstAt: 200, count: 10, gapMs: 150 });
    tracker.record({ kind: 'text', text: ' word'.repeat(30) }, 1000 + 200 + 10 * 150);
    const res = tracker.finalize({ endMs: 0 });
    expect(res.chunkCount).toBe(11);
    expect(res.outputTokens).toBe(40);
    expect(res.streaming).toBe(false);
    expect(res.decodeTps).toBeNull();
  });

  it('a single whole-answer chunk is buffered: no TTFT, no decode, no peak, E2E only', () => {
    const tracker = new RollingSpeedTracker('download', 0);
    tracker.record({ kind: 'meta' }, 122);
    tracker.record({ kind: 'text', text: ' word'.repeat(400) }, 25_000);
    tracker.record({ kind: 'terminal', outputTokens: 440, reasoningTokens: 26 }, 25_023);
    const res = tracker.finalize({ endMs: 26_300 });
    expect(res.isBuffered).toBe(true);
    expect(res.ttftMs).toBeNull();
    expect(res.decodeTps).toBeNull();
    expect(res.peakTps).toBeNull();
    expect(res.e2eTps).toBe(16);
    expect(res.durationMs).toBe(25_023);
    expect(rankOf(res)).toEqual({ rankTps: 16, rankMetric: 'e2e' });
  });

  it('an adapter-declared buffered route is never streaming, whatever the chunking', () => {
    const tracker = streamed({ firstAt: 300, count: 30, gapMs: 100 });
    tracker.record({ kind: 'meta', buffered: true }, 1000 + 4000);
    expect(tracker.finalize({ endMs: 0 }).streaming).toBe(false);
  });

  it('streamed thinking never counts as visible output or as TTFT', () => {
    const tracker = new RollingSpeedTracker('download', 0);
    for (let i = 0; i < 50; i++) tracker.record({ kind: 'thinking', text: ' ponder' }, 500 + i * 20);
    for (let i = 0; i < 11; i++) tracker.record({ kind: 'text', text: ' word' }, 3000 + i * 100);
    const res = tracker.finalize({ endMs: 0 });
    expect(res.firstActivityMs).toBe(500);
    expect(res.ttftMs).toBe(3000);
    expect(res.thinkingTokens).toBe(50);
    expect(res.outputTokens).toBe(11);
    expect(res.decodeTps).toBe(10);
  });
});

describe('peak, gaps and live gauge', () => {
  it('peak is the best full 1-second window and ignores the first-chunk burst', () => {
    const t0 = 0;
    const tracker = new RollingSpeedTracker('download', t0);
    // A 55-token burst arriving with the first chunk must not become the peak.
    tracker.record({ kind: 'text', text: ' word'.repeat(55) }, 3481);
    // 3 s at 10 tok/s, then 2 s at 40 tok/s.
    for (let i = 1; i <= 30; i++) tracker.record({ kind: 'text', text: ' word' }, 3481 + i * 100);
    for (let i = 1; i <= 80; i++) tracker.record({ kind: 'text', text: ' word' }, 6481 + i * 25);
    const res = tracker.finalize({ endMs: 0 });
    expect(res.streaming).toBe(true);
    expect(res.peakTps).toBe(40);
    expect(res.decodeTps).toBe(22);
  });

  it('no peak is reported before one second of visible streaming', () => {
    const tracker = streamed({ firstAt: 100, count: 10, gapMs: 100 });
    expect(tracker.toGaugeTick(1000 + 1050).peakTps).toBe(0);
    tracker.record({ kind: 'text', text: ' word' }, 1000 + 1100);
    expect(tracker.toGaugeTick(1000 + 1100).peakTps).toBe(10);
  });

  it('ticking is read-only: any number of gauge ticks leaves the result unchanged', () => {
    const build = (ticks: number) => {
      const tracker = streamed({ firstAt: 200, count: 40, gapMs: 50 });
      for (let i = 0; i < ticks; i++) tracker.toGaugeTick(1000 + 200 + i * 7);
      return tracker.finalize({ endMs: 0 });
    };
    expect(build(500)).toEqual(build(0));
  });

  it('jitter is the mean absolute deviation of the gaps; median gap and longest stall are reported', () => {
    const tracker = new RollingSpeedTracker('download', 0);
    // Gaps: 100 x7, then one 500 ms stall, then 100 x2  ->  mean 140, MAD 72.
    const times = [100, 200, 300, 400, 500, 600, 700, 800, 1300, 1400, 1500];
    for (const t of times) tracker.record({ kind: 'text', text: ' word' }, t);
    const res = tracker.finalize({ endMs: 0 });
    expect(res.streaming).toBe(true);
    expect(res.medianGapMs).toBe(100);
    expect(res.maxStallMs).toBe(500);
    expect(res.jitterMs).toBe(72);
  });

  it('the live gauge uses the same 1-second window and reports the stage', () => {
    const tracker = new RollingSpeedTracker('download', 0);
    expect(tracker.toGaugeTick(50).stage).toBe('booting');
    tracker.record({ kind: 'init', model: 'm' }, 100);
    expect(tracker.toGaugeTick(150)).toMatchObject({ stage: 'waiting', readyMs: 100, model: 'm' });
    tracker.record({ kind: 'thinking', text: 'hmm' }, 200);
    expect(tracker.toGaugeTick(250)).toMatchObject({ stage: 'thinking', currentTps: 0, thinkingTokens: 1 });
    for (let i = 0; i <= 30; i++) tracker.record({ kind: 'text', text: ' word' }, 1000 + i * 50);
    const tick = tracker.toGaugeTick(2500);
    expect(tick.stage).toBe('streaming');
    expect(tick.ttftMs).toBe(1000);
    expect(tick.tokensGenerated).toBe(31);
    expect(tick.currentTps).toBe(20);
    expect(tick.peakTps).toBe(20);
    // 30 tokens after the first chunk over 1.5 s.
    expect(tick.averageTps).toBe(20);
  });
});

describe('short output flag', () => {
  it('flags a download that streamed for under 2 s or produced under 150 tokens', () => {
    const shortTime = streamed({ firstAt: 100, count: 30, gapMs: 50, wordsEach: 10 }).finalize({ endMs: 0 });
    expect(shortTime.outputTokens).toBe(300);
    expect(shortTime.shortOutput).toBe(true);

    const fewTokens = streamed({ firstAt: 100, count: 30, gapMs: 100 }).finalize({ endMs: 0 });
    expect(fewTokens.streamMs).toBe(2900);
    expect(fewTokens.shortOutput).toBe(true);

    const fine = streamed({ firstAt: 100, count: 40, gapMs: 100, wordsEach: 5 }).finalize({ endMs: 0 });
    expect(fine.shortOutput).toBe(false);
    expect(fine.outputWords).toBe(200);
  });

  it('is only raised for the download phase', () => {
    expect(streamed({ phase: 'ping', firstAt: 100, count: 1, gapMs: 0 }).finalize({ endMs: 0 }).shortOutput).toBe(false);
  });
});

describe('upload prefill', () => {
  const base = { ttftMs: 2400, promptTokens: 3000, verified: true } as const;

  it('uses the extra TTFT over the ping phase', () => {
    expect(computeUploadPrefill(base, 900)).toEqual({ uploadOverheadMs: 1500, prefillTps: 2000 });
  });

  it('gives no rate for an unverified answer', () => {
    const res = computeUploadPrefill({ ...base, verified: false }, 900);
    expect(res.prefillTps).toBeNull();
    expect(res.prefillReason).toBe('answer not verified');
  });

  it('gives no rate when the overhead is within run-to-run noise or negative', () => {
    expect(computeUploadPrefill({ ...base, ttftMs: 4000 }, 3840).prefillTps).toBeNull();
    expect(computeUploadPrefill({ ...base, ttftMs: 4700 }, 4000).prefillTps).toBeNull();
    expect(computeUploadPrefill(base, 2350).prefillTps).toBeNull();
    expect(computeUploadPrefill(base, 2350).uploadOverheadMs).toBe(50);
    expect(computeUploadPrefill(base, 3000).prefillTps).toBeNull();
    expect(computeUploadPrefill(base, 3000).prefillReason).toContain('too small');
  });

  it('gives no rate without a TTFT on either side', () => {
    expect(computeUploadPrefill({ ...base, ttftMs: null }, 900).prefillReason).toContain('buffered');
    expect(computeUploadPrefill(base, null).prefillReason).toContain('no ping');
    expect(computeUploadPrefill(base, undefined).prefillTps).toBeNull();
  });

  it('prefers a vendor-reported prompt-eval duration', () => {
    const res = computeUploadPrefill({ ...base, promptEvalDurationMs: 600 }, null);
    expect(res.prefillTps).toBe(5000);
  });
});

describe('grade and ranking', () => {
  it('grades TPS tiers', () => {
    expect(computeGrade(155)).toBe('HYPER');
    expect(computeGrade(95)).toBe('TURBO');
    expect(computeGrade(55)).toBe('CRUISING');
    expect(computeGrade(25)).toBe('STEADY');
    expect(computeGrade(12)).toBe('CRAWLING');
  });

  it('ranks on decode TPS when streaming and on E2E TPS when buffered', () => {
    expect(rankOf({ streaming: true, decodeTps: 80, e2eTps: 30 })).toEqual({ rankTps: 80, rankMetric: 'decode' });
    expect(rankOf({ streaming: false, decodeTps: null, e2eTps: 30 })).toEqual({ rankTps: 30, rankMetric: 'e2e' });
  });

  it('sorts every streaming target before every buffered one', () => {
    const mk = (id: string, rankMetric: 'decode' | 'e2e', rankTps: number) =>
      ({ targetId: id, summary: { rankMetric, rankTps } }) as unknown as SpeedtestResult;
    const sorted = [mk('buffered-fast', 'e2e', 300), mk('slow', 'decode', 20), mk('fast', 'decode', 90), mk('buffered-slow', 'e2e', 10)]
      .sort(compareResultsByRank)
      .map((r) => r.targetId);
    expect(sorted).toEqual(['fast', 'slow', 'buffered-fast', 'buffered-slow']);
  });

  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('payloads', () => {
  it('asks for 30 sentences of about 20 words (60 in full mode)', () => {
    expect(buildDownloadPayload('quick')).toMatchObject({ sentenceCount: 30, wordsPerSentence: 20 });
    expect(buildDownloadPayload('standard').sentenceCount).toBe(30);
    expect(buildDownloadPayload('full').sentenceCount).toBe(60);
    expect(buildDownloadPayload('full').prompt).toContain('from 1 to 60, each about 20 words');
  });

  it('upload payload carries its marker, a cache-busting nonce and its normalized size', () => {
    const a = buildUploadPrefillPayload('standard');
    const b = buildUploadPrefillPayload('standard');
    expect(a.prompt).toContain(`marker=${a.expectedCode}`);
    expect(a.promptTokens).toBe(estimateTokens(a.prompt));
    expect(a.prompt.split('\n')[0]).not.toBe(b.prompt.split('\n')[0]);
  });
});
