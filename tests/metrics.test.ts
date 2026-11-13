import { describe, expect, it } from 'vitest';
import { computeGrade, RollingSpeedTracker } from '../src/core/metrics.js';
import { estimateTokens } from '../src/core/tokenizer.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string and >= 1 for non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hi')).toBe(1);
    expect(estimateTokens('hello world')).toBeGreaterThanOrEqual(2);
  });

  it('splits long words and non-ASCII text sensibly', () => {
    const longWord = estimateTokens('supercalifragilisticexpialidocious');
    expect(longWord).toBeGreaterThanOrEqual(5);
    const cjk = estimateTokens('你好世界测试');
    expect(cjk).toBeGreaterThanOrEqual(3);
  });
});

describe('RollingSpeedTracker', () => {
  it('computes accurate streaming decode TPS and reconciles reported outputTokens', () => {
    const t0 = 1000;
    const tracker = new RollingSpeedTracker('download', t0);
    tracker.markInit(t0 + 50);

    // 10 chunks spaced 100ms apart starting at t0 + 300ms (span = 900ms)
    for (let i = 0; i < 10; i++) {
      tracker.recordDelta('hello world ', 'text', t0 + 300 + i * 100);
    }

    const res = tracker.finalize(t0 + 1250, {
      inputTokens: 40,
      outputTokens: 100,
    });

    expect(res.isBuffered).toBe(false);
    expect(res.tokenSource).toBe('reported');
    expect(res.outputTokens).toBe(100);
    expect(res.ttftMs).toBe(300);
    expect(res.initMs).toBe(50);
    // 90 remaining tokens over 0.9s => 100 tok/s
    expect(res.decodeTps).toBeCloseTo(100, 0);
    expect(res.e2eTps).toBeCloseTo(80, 0);
    expect(Number.isFinite(res.decodeTps)).toBe(true);
  });

  it('falls back cleanly for single-chunk buffered responses (never Infinity)', () => {
    const t0 = 5000;
    const tracker = new RollingSpeedTracker('download', t0);
    tracker.recordDelta('One giant buffered block of text returned all at once.', 'text', t0 + 800);

    const res = tracker.finalize(t0 + 1000, { outputTokens: 20 });
    expect(res.isBuffered).toBe(true);
    expect(Number.isFinite(res.decodeTps)).toBe(true);
    expect(res.decodeTps).toBeCloseTo(20, 1);
  });

  it('computes RFC 3550 jitter and median ITL across variable chunk spacing', () => {
    const t0 = 100;
    const tracker = new RollingSpeedTracker('download', t0);
    // 4 chunks of ~1 token each at +100, +120 (+20ms), +160 (+40ms), +180 (+20ms)
    tracker.recordDelta('a', 'text', t0 + 100);
    tracker.recordDelta('b', 'text', t0 + 120);
    tracker.recordDelta('c', 'text', t0 + 160);
    tracker.recordDelta('d', 'text', t0 + 180);

    const { medianItlMs, jitterMs } = tracker.computeJitterAndItl();
    // ITLs: [20, 40, 20] -> sorted [20, 20, 40] -> median 20
    expect(medianItlMs).toBe(20);
    // Diffs: |40-20|=20, |20-40|=20 -> mean 20
    expect(jitterMs).toBe(20);
  });

  it('guards peakTps against initial burst before 400ms / 8 tokens', () => {
    const t0 = 1000;
    const tracker = new RollingSpeedTracker('download', t0);
    tracker.recordDelta('First ', 'text', t0 + 200);
    const earlyTick = tracker.toGaugeTick(t0 + 220);
    expect(earlyTick.peakTps).toBe(earlyTick.currentTps);

    // Add steady tokens past 400ms and 8 tokens
    for (let i = 1; i <= 10; i++) {
      tracker.recordDelta('token ', 'text', t0 + 200 + i * 60);
    }
    const laterTick = tracker.toGaugeTick(t0 + 850);
    expect(laterTick.tokensGenerated).toBeGreaterThanOrEqual(8);
    expect(laterTick.peakTps).toBeGreaterThan(0);
  });

  it('grades TPS tiers accurately', () => {
    expect(computeGrade(155)).toBe('HYPER');
    expect(computeGrade(95)).toBe('TURBO');
    expect(computeGrade(55)).toBe('CRUISING');
    expect(computeGrade(25)).toBe('STEADY');
    expect(computeGrade(12)).toBe('CRAWLING');
  });
});
