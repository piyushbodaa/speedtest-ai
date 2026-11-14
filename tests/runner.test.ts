import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNdjsonHarness, runTextHarness } from '../src/adapters/harnesses/run-ndjson-harness.js';
import { createDemoAdapter } from '../src/adapters/providers/demo.js';
import { killAllChildren, liveChildCount } from '../src/adapters/utils/spawn.js';
import {
  InterruptedError,
  isInterruptedError,
  isPhaseTimeoutError,
  isTargetFailedError,
  TargetFailedError,
} from '../src/core/errors.js';
import { aggregateRuns, runSpeedtest, runSpeedtestRepeated } from '../src/core/runner.js';
import type {
  AdapterInvokeRequest,
  AdapterStreamChunk,
  SpeedtestAdapter,
  SpeedtestEvent,
  SpeedtestResult,
} from '../src/types.js';
import { createFakeCli, type FakeCli, type FakeStep, sleep } from './helpers/fake-cli.js';

let home: string;
let fake: FakeCli;
const historyFile = () => path.join(home, 'history.json');

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-home-'));
  process.env.SPEEDTEST_AI_HOME = home;
  fake = createFakeCli();
});
afterAll(() => {
  killAllChildren({ force: true });
  delete process.env.SPEEDTEST_AI_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fake.remove();
});

async function collect(gen: AsyncGenerator<SpeedtestEvent, SpeedtestResult, unknown>) {
  const events: SpeedtestEvent[] = [];
  let result: SpeedtestResult | undefined;
  let error: unknown;
  try {
    while (true) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      events.push(next.value);
    }
  } catch (err) {
    error = err;
  }
  return { events, result, error };
}

const types = (events: SpeedtestEvent[]) => events.filter((e) => e.type !== 'gauge:tick').map((e) => e.type);

type Script = (req: AdapterInvokeRequest) => AsyncGenerator<AdapterStreamChunk, void, unknown>;

function scripted(stream: Script, overrides: Partial<SpeedtestAdapter> = {}): SpeedtestAdapter {
  return {
    id: 'fake',
    name: 'Fake Target',
    category: 'harness',
    tier: 'verified',
    supportsToolLoop: false,
    stream,
    ...overrides,
  };
}

function abortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/** Streams `count` chunks of `words` words every `gapMs` after `firstAt`, then a terminal event. */
function steady(options: { firstAt: number; count: number; gapMs: number; words?: number; lingerMs?: number; terminal?: boolean }): Script {
  return async function* (req) {
    yield { kind: 'start' };
    await abortable(options.firstAt, req.signal);
    for (let i = 0; i < options.count; i++) {
      if (i > 0) await abortable(options.gapMs, req.signal);
      yield { kind: 'text', text: ' word'.repeat(options.words ?? 1) };
    }
    if (options.terminal !== false) yield { kind: 'terminal', model: 'fake-model-1', outputTokens: 4242 };
    if (options.lingerMs) await sleep(options.lingerMs);
  };
}

describe('runSpeedtest with the demo adapter', () => {
  it('quick mode: one streamed download with every headline metric', async () => {
    const { events, result, error } = await collect(
      runSpeedtest({ adapter: createDemoAdapter('flash', { timeScale: 0.5 }), mode: 'quick', noHistory: true })
    );
    expect(error).toBeUndefined();
    expect(types(events)).toEqual(['run:start', 'phase:start', 'phase:complete', 'run:complete']);
    expect(events[0]).toMatchObject({ type: 'run:start', phases: ['download'], runs: 1 });

    const r = result!;
    expect(r.schemaVersion).toBe(2);
    expect(r.targetId).toBe('demo');
    expect(r.tier).toBe('verified');
    expect(r.model).toBe('demo-flash-v2');
    expect(r.runs).toBe(1);
    expect(r.aggregate).toBeUndefined();
    expect(r.isolation).toBeUndefined();
    expect(r.notes).toContain('simulated data, not a real model');
    expect(r.skipped).toEqual([]);

    const s = r.summary;
    expect(s.streaming).toBe(true);
    expect(s.isBuffered).toBe(false);
    expect(s.tokenUnit).toBe('normalized');
    expect(s.rankMetric).toBe('decode');
    expect(s.rankTps).toBe(s.downloadDecodeTps);
    // Profile is 168 tok/s at half the delays; timers add overhead, so the band is wide.
    expect(s.downloadDecodeTps!).toBeGreaterThan(200);
    expect(s.downloadDecodeTps!).toBeLessThan(380);
    expect(s.downloadPeakTps!).toBeGreaterThanOrEqual(s.downloadDecodeTps!);
    expect(s.downloadE2eTps).toBeLessThan(s.downloadDecodeTps!);
    expect(s.ttftMs).toBe(s.downloadTtftMs);
    expect(s.ttftMs!).toBeGreaterThan(40);
    expect(s.readyMs!).toBeLessThan(s.ttftMs!);
    expect(s.downloadOutputWords).toBeGreaterThan(500);
    expect(s.downloadOutputTokens).toBeGreaterThan(600);
    expect(s.shortOutput).toBe(false);
    expect(s.jitterMs).not.toBeNull();
    expect(s.maxStallMs).not.toBeNull();
    expect(s.grade).toBe('HYPER');
    expect(s.reportedOutputTokens).toBeGreaterThan(s.downloadOutputTokens);

    const ticks = events.filter((e) => e.type === 'gauge:tick');
    expect(ticks.length).toBeGreaterThan(10);
  }, 20_000);

  it('standard mode: ping, download, upload and tool loop all complete and verify', async () => {
    const { events, result, error } = await collect(
      runSpeedtest({ adapter: createDemoAdapter('flash', { timeScale: 0.5 }), mode: 'standard', noHistory: true })
    );
    expect(error).toBeUndefined();
    expect(events.filter((e) => e.type === 'phase:complete').map((e) => (e as any).phase)).toEqual([
      'ping',
      'download',
      'upload',
      'tool_loop',
    ]);
    const r = result!;
    const s = r.summary;
    expect(r.phases.ping!.verified).toBe(true);
    expect(s.ttftMs).toBe(r.phases.ping!.ttftMs);
    expect(s.uploadVerified).toBe(true);
    expect(s.uploadPromptTokens).toBeGreaterThan(1000);
    expect(s.uploadOverheadMs!).toBeGreaterThan(50);
    expect(s.uploadTtftMs!).toBeGreaterThan(s.ttftMs!);
    if (s.uploadPrefillTps === null) expect(s.uploadPrefillReason).toBeTruthy();
    else expect(s.uploadPrefillTps).toBeGreaterThan(1000);
    expect(s.toolLoopVerified).toBe(true);
    expect(s.toolLoopToolCalls).toBe(1);
    expect(s.toolLoopMs).toBeGreaterThan(100);
    expect(r.skipped).toEqual([]);
  }, 30_000);

  it('buffered profile: no TTFT, no decode TPS, ranked on E2E', async () => {
    const { result, error } = await collect(
      runSpeedtest({ adapter: createDemoAdapter('buffered', { timeScale: 0.1 }), mode: 'quick', noHistory: true })
    );
    expect(error).toBeUndefined();
    const s = result!.summary;
    expect(s.isBuffered).toBe(true);
    expect(s.streaming).toBe(false);
    expect(s.ttftMs).toBeNull();
    expect(s.downloadDecodeTps).toBeNull();
    expect(s.downloadPeakTps).toBeNull();
    expect(s.jitterMs).toBeNull();
    expect(s.rankMetric).toBe('e2e');
    expect(s.rankTps).toBe(s.downloadE2eTps);
    expect(s.downloadE2eTps).toBeGreaterThan(0);
  }, 20_000);

  it('reasoning profile: thinking is counted separately from visible output', async () => {
    const { result } = await collect(
      runSpeedtest({ adapter: createDemoAdapter('reasoning', { timeScale: 0.1 }), mode: 'quick', noHistory: true })
    );
    const d = result!.phases.download!;
    expect(d.thinkingTokens).toBeGreaterThan(10);
    expect(d.firstActivityMs!).toBeLessThan(d.ttftMs!);
    expect(d.reportedReasoningTokens).toBeGreaterThan(0);
  }, 20_000);

  it('rejects an unknown demo profile with a clear error', async () => {
    expect(() => createDemoAdapter('nosuch' as never)).toThrow(/Unknown demo profile "nosuch"/);
    const { error, events } = await collect(
      runSpeedtest({ adapter: createDemoAdapter('flash'), model: 'nosuch', mode: 'quick', noHistory: true })
    );
    expect(isTargetFailedError(error)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run:error', kind: 'failed', failureKind: 'model' });
  });
});

describe('runner timing model', () => {
  it('stops the clock at the terminal event, not when the adapter (process) finishes', async () => {
    const { result } = await collect(
      runSpeedtest({
        adapter: scripted(steady({ firstAt: 200, count: 12, gapMs: 100, lingerMs: 1200 })),
        mode: 'quick',
        noHistory: true,
      })
    );
    const d = result!.phases.download!;
    expect(d.streaming).toBe(true);
    expect(d.ttftMs!).toBeGreaterThanOrEqual(190);
    expect(d.ttftMs!).toBeLessThan(330);
    // 200 + 11 * 100 = 1300 ms to the last event; the 1.2 s linger is excluded.
    expect(d.durationMs).toBeGreaterThanOrEqual(1280);
    expect(d.durationMs).toBeLessThan(1700);
    expect(d.decodeTps!).toBeGreaterThan(8.5);
    expect(d.decodeTps!).toBeLessThan(10.5);
    expect(result!.model).toBe('fake-model-1');
    expect(result!.isolation).toBe('lean');
    expect(result!.summary.reportedOutputTokens).toBe(4242);
    expect(result!.summary.downloadOutputTokens).toBe(12);
  });

  it('measures from the start chunk, excluding adapter setup before the spawn', async () => {
    const script: Script = async function* (req) {
      await sleep(400); // sandbox / setup time before the process exists
      yield* steady({ firstAt: 150, count: 10, gapMs: 120 })(req);
    };
    const { result } = await collect(runSpeedtest({ adapter: scripted(script), mode: 'quick', noHistory: true }));
    const d = result!.phases.download!;
    expect(d.ttftMs!).toBeGreaterThanOrEqual(140);
    expect(d.ttftMs!).toBeLessThan(300);
  });

  it('passes asConfigured, the timeout and the model through to the adapter', async () => {
    const seen: AdapterInvokeRequest[] = [];
    const script: Script = async function* (req) {
      seen.push(req);
      yield* steady({ firstAt: 20, count: 9, gapMs: 130 })(req);
    };
    const { result } = await collect(
      runSpeedtest({ adapter: scripted(script), mode: 'quick', noHistory: true, asConfigured: true, timeoutMs: 7000, model: 'm-x' })
    );
    expect(seen[0]).toMatchObject({ phase: 'download', asConfigured: true, timeoutMs: 7000, model: 'm-x' });
    expect(seen[0].maxTokens).toBeGreaterThan(2000);
    expect(result!.isolation).toBe('as-configured');
  });

  it('collects adapter notes and extra fields into the result', async () => {
    const script: Script = async function* (req) {
      yield { kind: 'note', text: 'default model unavailable, retried with muse-spark-1.3' };
      yield { kind: 'meta', extra: { providerTtftMs: 4555 } };
      yield* steady({ firstAt: 20, count: 9, gapMs: 130 })(req);
    };
    const { result } = await collect(
      runSpeedtest({ adapter: scripted(script, { tier: 'experimental', notes: ['static note'] }), mode: 'quick', noHistory: true })
    );
    expect(result!.tier).toBe('experimental');
    expect(result!.notes).toEqual(['static note', 'default model unavailable, retried with muse-spark-1.3']);
    expect(result!.phases.download!.extra).toEqual({ providerTtftMs: 4555 });
  });
});

describe('runner failure semantics', () => {
  it('a phase timeout mid-stream is an error, emits run:error and saves nothing', async () => {
    const { events, result, error } = await collect(
      runSpeedtest({ adapter: scripted(steady({ firstAt: 50, count: 500, gapMs: 20 })), mode: 'quick', timeoutMs: 500 })
    );
    expect(result).toBeUndefined();
    expect(isPhaseTimeoutError(error)).toBe(true);
    expect((error as Error).message).toBe('Fake Target: download phase timed out after 1s');
    expect(events.at(-1)).toMatchObject({ type: 'run:error', phase: 'download', kind: 'timeout' });
    expect(types(events)).not.toContain('run:complete');
    expect(types(events)).not.toContain('phase:complete');
    expect(fs.existsSync(historyFile())).toBe(false);
  });

  it('an adapter that swallows the abort and returns partial text still fails', async () => {
    const stubborn: Script = async function* (req) {
      yield { kind: 'start' };
      for (let i = 0; i < 400 && !req.signal.aborted; i++) {
        yield { kind: 'text', text: ' word' };
        await sleep(10);
      }
    };
    const { result, error } = await collect(
      runSpeedtest({ adapter: scripted(stubborn), mode: 'quick', timeoutMs: 400, noHistory: true })
    );
    expect(result).toBeUndefined();
    expect(isPhaseTimeoutError(error)).toBe(true);
  });

  it('does not hang on an adapter that never reacts to the abort', async () => {
    const deaf: Script = async function* () {
      yield { kind: 'text', text: 'x' };
      await sleep(8000);
    };
    const t = Date.now();
    const { error } = await collect(
      runSpeedtest({ adapter: scripted(deaf), mode: 'quick', timeoutMs: 300, noHistory: true })
    );
    expect(isPhaseTimeoutError(error)).toBe(true);
    expect(Date.now() - t).toBeLessThan(4500);
  }, 10_000);

  it('a user interrupt is an InterruptedError, never a result', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new InterruptedError()), 400);
    const { events, result, error } = await collect(
      runSpeedtest({
        adapter: scripted(steady({ firstAt: 50, count: 500, gapMs: 20 })),
        mode: 'quick',
        signal: controller.signal,
      })
    );
    expect(result).toBeUndefined();
    expect(isInterruptedError(error)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run:error', kind: 'interrupted' });
    expect(fs.existsSync(historyFile())).toBe(false);
  });

  it('a plain abort() without a reason also counts as an interrupt', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const { error } = await collect(
      runSpeedtest({ adapter: createDemoAdapter('local'), mode: 'quick', signal: controller.signal, noHistory: true })
    );
    expect(isInterruptedError(error)).toBe(true);
  });

  it('an already-aborted signal fails before the adapter is invoked', async () => {
    let invoked = false;
    const controller = new AbortController();
    controller.abort(new InterruptedError());
    const script: Script = async function* () {
      invoked = true;
      yield { kind: 'text', text: 'x' };
    };
    const { error } = await collect(
      runSpeedtest({ adapter: scripted(script), mode: 'quick', signal: controller.signal, noHistory: true })
    );
    expect(isInterruptedError(error)).toBe(true);
    expect(invoked).toBe(false);
  });

  it('an interrupt during an optional phase stops the whole run', async () => {
    const controller = new AbortController();
    const script: Script = async function* (req) {
      if (req.phase === 'ping') {
        yield { kind: 'text', text: 'PONG' };
        return;
      }
      if (req.phase === 'download') {
        yield* steady({ firstAt: 20, count: 9, gapMs: 130 })(req);
        return;
      }
      setTimeout(() => controller.abort(new InterruptedError()), 100);
      await abortable(5000, req.signal);
    };
    const { events, error } = await collect(
      runSpeedtest({ adapter: scripted(script), mode: 'standard', signal: controller.signal, noHistory: true })
    );
    expect(isInterruptedError(error)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run:error', phase: 'upload', kind: 'interrupted' });
  });

  it('wraps an arbitrary adapter error as TargetFailedError and classifies it', async () => {
    const script: Script = async function* () {
      yield { kind: 'text', text: 'partial' };
      throw new Error('HTTP 401: invalid api key');
    };
    const { events, error } = await collect(runSpeedtest({ adapter: scripted(script), mode: 'quick', noHistory: true }));
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as TargetFailedError).kind).toBe('auth');
    expect(events.at(-1)).toMatchObject({ type: 'run:error', kind: 'failed', failureKind: 'auth' });
  });

  it('zero visible output fails the run with run:error', async () => {
    const script: Script = async function* () {
      yield { kind: 'thinking', text: 'only thoughts' };
      yield { kind: 'terminal' };
    };
    const { events, error } = await collect(runSpeedtest({ adapter: scripted(script), mode: 'quick', noHistory: true }));
    expect((error as Error).message).toBe('Fake Target produced no visible output');
    expect(events.at(-1)).toMatchObject({ type: 'run:error', phase: 'download' });
  });

  it('a failed ping fails the run before any tokens are spent on the download', async () => {
    const phases: string[] = [];
    const script: Script = async function* (req) {
      phases.push(req.phase);
      throw new TargetFailedError('fake: not logged in', { kind: 'auth' });
    };
    const { error } = await collect(runSpeedtest({ adapter: scripted(script), mode: 'standard', noHistory: true }));
    expect((error as TargetFailedError).kind).toBe('auth');
    expect(phases).toEqual(['ping']);
  });
});

describe('secondary phases', () => {
  function standardAdapter(behaviour: { upload: 'ok' | 'wrong' | 'throw'; tool: 'ok' | 'no-tool-call' | 'wrong' }) {
    const script: Script = async function* (req) {
      yield { kind: 'start' };
      if (req.phase === 'ping') {
        await sleep(100);
        yield { kind: 'text', text: 'PONG' };
        yield { kind: 'terminal' };
      } else if (req.phase === 'download') {
        yield* steady({ firstAt: 100, count: 9, gapMs: 130 })(req);
      } else if (req.phase === 'upload') {
        if (behaviour.upload === 'throw') throw new TargetFailedError('fake: context too long');
        await sleep(900);
        const code = req.prompt.match(/marker=(VERIFY-[A-Z0-9]+)/)![1];
        yield { kind: 'text', text: behaviour.upload === 'ok' ? code : 'VERIFY-WRONG1' };
        yield { kind: 'terminal' };
      } else {
        const token = fs.readFileSync(path.join(req.cwd!, 'probe.txt'), 'utf8');
        if (behaviour.tool !== 'no-tool-call') yield { kind: 'tool_call', toolName: 'Read' };
        yield { kind: 'text', text: behaviour.tool === 'wrong' ? 'PROBE-NOPE' : token };
        yield { kind: 'terminal' };
      }
    };
    return scripted(script, { supportsToolLoop: true });
  }

  it('a verified upload reports TTFT overhead over the ping and a prefill rate', async () => {
    const { result } = await collect(
      runSpeedtest({ adapter: standardAdapter({ upload: 'ok', tool: 'ok' }), mode: 'standard', noHistory: true })
    );
    const s = result!.summary;
    expect(s.uploadVerified).toBe(true);
    expect(s.uploadOverheadMs!).toBeGreaterThan(700);
    expect(s.uploadOverheadMs!).toBeLessThan(950);
    expect(s.uploadPrefillTps).toBeCloseTo(s.uploadPromptTokens! / (s.uploadOverheadMs! / 1000), 0);
    expect(s.toolLoopVerified).toBe(true);
    expect(result!.phases.upload!.uploadOverheadMs).toBe(s.uploadOverheadMs);
    expect(result!.skipped).toEqual([]);
  });

  it('an unverified upload is a failed phase: phase:skip, no rate, no phase result', async () => {
    const { events, result, error } = await collect(
      runSpeedtest({ adapter: standardAdapter({ upload: 'wrong', tool: 'ok' }), mode: 'standard', noHistory: true })
    );
    expect(error).toBeUndefined();
    expect(events.find((e) => e.type === 'phase:skip')).toMatchObject({ phase: 'upload' });
    expect(result!.phases.upload).toBeUndefined();
    expect(result!.summary.uploadVerified).toBe(false);
    expect(result!.summary.uploadPrefillTps).toBeUndefined();
    expect(result!.skipped).toEqual([
      { phase: 'upload', reason: 'answer not verified: the expected marker was not in the reply' },
    ]);
    // The run itself is still valid.
    expect(result!.summary.rankTps).toBeGreaterThan(0);
  });

  it('an upload that throws is skipped with its reason and the tool loop still runs', async () => {
    const { result } = await collect(
      runSpeedtest({ adapter: standardAdapter({ upload: 'throw', tool: 'ok' }), mode: 'standard', noHistory: true })
    );
    expect(result!.skipped).toEqual([{ phase: 'upload', reason: 'fake: context too long' }]);
    expect(result!.summary.uploadVerified).toBeUndefined();
    expect(result!.summary.toolLoopVerified).toBe(true);
  });

  it('a tool loop without an observed tool call is failed even when the token matches', async () => {
    const { result } = await collect(
      runSpeedtest({ adapter: standardAdapter({ upload: 'ok', tool: 'no-tool-call' }), mode: 'standard', noHistory: true })
    );
    expect(result!.phases.tool_loop).toBeUndefined();
    expect(result!.summary.toolLoopVerified).toBe(false);
    expect(result!.skipped[0]).toMatchObject({ phase: 'tool_loop' });
    expect(result!.skipped[0].reason).toContain('no tool call observed');
  });

  it('a tool loop with the wrong token is failed', async () => {
    const { result } = await collect(
      runSpeedtest({ adapter: standardAdapter({ upload: 'ok', tool: 'wrong' }), mode: 'standard', noHistory: true })
    );
    expect(result!.summary.toolLoopVerified).toBe(false);
    expect(result!.skipped[0].reason).toContain('not verified');
  });

  it('the tool loop is not attempted for targets without tool support', async () => {
    const adapter = { ...standardAdapter({ upload: 'ok', tool: 'ok' }), supportsToolLoop: false };
    const { events } = await collect(runSpeedtest({ adapter, mode: 'standard', noHistory: true }));
    expect(events[0]).toMatchObject({ phases: ['ping', 'download', 'upload'] });
  });
});

describe('runSpeedtestRepeated (--runs)', () => {
  it('repeats only the download phase and reports medians with the min-max', async () => {
    const calls: string[] = [];
    let downloadRun = 0;
    const gaps = [100, 50, 200]; // decode ~10, ~20, ~5 tok/s
    const script: Script = async function* (req) {
      calls.push(req.phase);
      if (req.phase === 'ping') {
        yield { kind: 'start' };
        await sleep(80);
        yield { kind: 'text', text: 'PONG' };
        yield { kind: 'terminal', costUsd: 0.01 };
        return;
      }
      if (req.phase === 'upload') {
        throw new TargetFailedError('skip upload');
      }
      const gapMs = gaps[downloadRun++];
      for await (const chunk of steady({ firstAt: 50, count: Math.max(9, Math.ceil(1100 / gapMs) + 1), gapMs })(req)) {
        yield chunk.kind === 'terminal' ? { ...chunk, costUsd: 0.1 } : chunk;
      }
    };
    const { events, result, error } = await collect(
      runSpeedtestRepeated({ adapter: scripted(script), mode: 'standard', runs: 3 })
    );
    expect(error).toBeUndefined();
    expect(calls).toEqual(['ping', 'download', 'upload', 'download', 'download']);
    expect(types(events).filter((t) => t.startsWith('r'))).toEqual([
      'run:start',
      'repeat:start',
      'repeat:complete',
      'repeat:start',
      'repeat:complete',
      'repeat:start',
      'repeat:complete',
      'run:complete',
    ]);
    expect(events.find((e) => e.type === 'run:start')).toMatchObject({ runs: 3 });

    const r = result!;
    expect(r.runs).toBe(3);
    const agg = r.aggregate!;
    expect(agg).toMatchObject({ requested: 3, completed: 3, failed: [] });
    expect(agg.samples.map((s) => s.run)).toEqual([1, 2, 3]);
    const decodes = agg.samples.map((s) => s.decodeTps!);
    expect(decodes[0]).toBeGreaterThan(8.5);
    expect(decodes[0]).toBeLessThan(10.5);
    expect(decodes[1]).toBeGreaterThan(16);
    expect(decodes[2]).toBeLessThan(5.5);
    // Median is the first run (~10); min and max are the other two.
    expect(r.summary.downloadDecodeTps).toBe(decodes[0]);
    expect(r.summary.rankTps).toBe(decodes[0]);
    expect(agg.decodeTpsMin).toBe(decodes[2]);
    expect(agg.decodeTpsMax).toBe(decodes[1]);
    expect(agg.spreadPct).toBeGreaterThan(100);
    expect(r.phases.download!.decodeTps).toBe(decodes[0]);
    // Ping comes from the first run only; cost is summed over everything that ran.
    expect(r.summary.ttftMs).toBe(r.phases.ping!.ttftMs);
    expect(r.summary.costUsd).toBeCloseTo(0.31, 5);
    expect(r.skipped).toEqual([{ phase: 'upload', reason: 'skip upload' }]);

    // Exactly one history entry: the aggregate.
    const saved = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(r.id);
    expect(saved[0].aggregate.completed).toBe(3);
    fs.rmSync(historyFile());
  }, 20_000);

  it('runs = 1 behaves exactly like runSpeedtest (no repeat events, no aggregate)', async () => {
    const { events, result } = await collect(
      runSpeedtestRepeated({ adapter: scripted(steady({ firstAt: 20, count: 9, gapMs: 130 })), mode: 'quick', runs: 1, noHistory: true })
    );
    expect(types(events)).toEqual(['run:start', 'phase:start', 'phase:complete', 'run:complete']);
    expect(result!.aggregate).toBeUndefined();
    expect(result!.runs).toBe(1);
  });

  it('clamps runs to 1..5', async () => {
    const { events } = await collect(
      runSpeedtestRepeated({ adapter: scripted(steady({ firstAt: 5, count: 9, gapMs: 130 })), mode: 'quick', runs: 99, noHistory: true })
    );
    expect(events.filter((e) => e.type === 'repeat:start')).toHaveLength(5);
  }, 20_000);

  it('a later sample that fails stops the repetition and is listed, keeping the completed ones', async () => {
    let n = 0;
    const script: Script = async function* (req) {
      if (++n === 2) throw new TargetFailedError('fake: 529 overloaded');
      yield* steady({ firstAt: 20, count: 9, gapMs: 130 })(req);
    };
    const { result, error, events } = await collect(
      runSpeedtestRepeated({ adapter: scripted(script), mode: 'quick', runs: 3, noHistory: true })
    );
    expect(error).toBeUndefined();
    expect(n).toBe(2);
    expect(result!.runs).toBe(1);
    expect(result!.aggregate).toMatchObject({ requested: 3, completed: 1, failed: [{ run: 2, error: 'fake: 529 overloaded' }] });
    expect(result!.notes).toContain('run 2 of 3 failed: fake: 529 overloaded');
    expect(types(events)).not.toContain('run:error');
  });

  it('an interrupt during a later sample throws and saves nothing', async () => {
    const controller = new AbortController();
    let n = 0;
    const script: Script = async function* (req) {
      if (++n === 2) setTimeout(() => controller.abort(new InterruptedError()), 150);
      yield* steady({ firstAt: 20, count: 9, gapMs: 130 })(req);
    };
    const { result, error, events } = await collect(
      runSpeedtestRepeated({ adapter: scripted(script), mode: 'quick', runs: 3, signal: controller.signal })
    );
    expect(result).toBeUndefined();
    expect(isInterruptedError(error)).toBe(true);
    expect(events.filter((e) => e.type === 'run:error')).toHaveLength(1);
    expect(fs.existsSync(historyFile())).toBe(false);
  });

  it('a first sample that fails throws with a single run:error', async () => {
    const script: Script = async function* () {
      throw new TargetFailedError('fake: boom');
    };
    const { error, events } = await collect(
      runSpeedtestRepeated({ adapter: scripted(script), mode: 'quick', runs: 3, noHistory: true })
    );
    expect((error as Error).message).toBe('fake: boom');
    expect(events.filter((e) => e.type === 'run:error')).toHaveLength(1);
  });

  it('aggregateRuns: a majority of buffered samples makes the aggregate buffered', () => {
    const mk = (streaming: boolean, decode: number | null, e2e: number): SpeedtestResult =>
      ({
        schemaVersion: 2,
        id: 'x',
        notes: [],
        skipped: [],
        runs: 1,
        summary: { rankTps: streaming ? decode : e2e, rankMetric: streaming ? 'decode' : 'e2e', totalDurationMs: 10, ttftMs: 5 },
        phases: {
          download: {
            streaming, isBuffered: !streaming, decodeTps: decode, e2eTps: e2e, peakTps: decode, ttftMs: streaming ? 100 : null,
            durationMs: 1000, streamMs: 900, outputTokens: 100, outputWords: 80, thinkingTokens: 0,
            jitterMs: streaming ? 3 : null, medianGapMs: streaming ? 10 : null, maxStallMs: streaming ? 40 : null, shortOutput: false,
          },
        },
      }) as unknown as SpeedtestResult;
    const agg = aggregateRuns([mk(false, null, 20), mk(true, 90, 40), mk(false, null, 30)], 3);
    expect(agg.summary).toMatchObject({ isBuffered: true, rankMetric: 'e2e', rankTps: 30, downloadDecodeTps: null, ttftMs: null });
    expect(agg.aggregate).toMatchObject({ rankTpsMin: 20, rankTpsMax: 40, decodeTpsMin: 90, decodeTpsMax: 90 });

    // The per-phase detail must come from a sample of the same kind as the aggregate.
    const mixed = aggregateRuns([mk(true, 50, 40), mk(true, 60, 45), mk(false, null, 55)], 3);
    expect(mixed.summary).toMatchObject({ rankMetric: 'decode', rankTps: 55 });
    expect(mixed.phases.download).toMatchObject({ streaming: true });
  });

  it('stops the adapter when the consumer breaks out of the event stream', async () => {
    let aborted = false;
    const adapter: SpeedtestAdapter = {
      id: 'slow',
      name: 'Slow',
      category: 'custom',
      tier: 'verified',
      supportsToolLoop: false,
      async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
        yield { kind: 'start' };
        yield { kind: 'text', text: 'hello ' };
        await new Promise<void>((resolve) => {
          req.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
        throw req.signal.reason;
      },
    };
    for await (const ev of runSpeedtest({ adapter, mode: 'quick', noHistory: true, timeoutMs: 60_000 })) {
      if (ev.type === 'gauge:tick') break;
    }
    expect(aborted).toBe(true);
  });
});

describe('runner + harness + real child processes', () => {
  function fakeHarnessAdapter(steps: (req: AdapterInvokeRequest) => FakeStep[], pids: number[] = []): SpeedtestAdapter {
    return scripted((req) =>
      runNdjsonHarness({
        binaryPath: process.execPath,
        label: 'fakecli',
        req,
        buildArgs: () => fake.args(steps(req)),
        createParser: () => (event) => {
          const ev = event as Record<string, any>;
          if (ev.pid) pids.push(ev.pid);
          if (ev.t === 'init') return [{ kind: 'init', model: ev.model }];
          if (ev.t === 'text') return [{ kind: 'text', text: ev.v }];
          if (ev.t === 'done') return [{ kind: 'terminal', outputTokens: ev.out, inputTokens: ev.in }];
          return [];
        },
      })
    );
  }

  function streamSteps(count: number, gapMs: number, tail: FakeStep[] = []): FakeStep[] {
    const steps: FakeStep[] = [{ pid: true }, { wait: 150 }, { out: { t: 'init', model: 'fake-cli-model' } }, { wait: 200 }];
    for (let i = 0; i < count; i++) steps.push({ out: { t: 'text', v: ` word${i} and more` } }, { wait: gapMs });
    return [...steps, ...tail];
  }

  it('end to end: spawn is t0, the terminal event stops the clock, teardown is not measured', async () => {
    const t = Date.now();
    const { result, error } = await collect(
      runSpeedtest({
        adapter: fakeHarnessAdapter(() =>
          streamSteps(25, 60, [{ out: { t: 'done', out: 321, in: 18000 } }, { ignoreSigterm: true }, { wait: 30_000 }])
        ),
        mode: 'quick',
        noHistory: true,
      })
    );
    expect(error).toBeUndefined();
    const d = result!.phases.download!;
    expect(result!.model).toBe('fake-cli-model');
    expect(d.streaming).toBe(true);
    // node boot + 150 ms before the first event, 200 ms more before the first text.
    expect(d.readyMs!).toBeGreaterThan(20);
    expect(d.readyMs!).toBeLessThan(d.ttftMs!);
    expect(d.ttftMs!).toBeGreaterThanOrEqual(350);
    expect(d.ttftMs!).toBeLessThan(900);
    expect(d.outputTokens).toBe(25 * 4);
    expect(d.durationMs).toBeLessThan(3000);
    expect(d.reportedOutputTokens).toBe(321);
    expect(d.reportedInputTokens).toBe(18000);
    // The child ignored SIGTERM and wanted 30 s more; the run waited at most for the SIGKILL escalation.
    expect(Date.now() - t).toBeLessThan(6000);
    expect(liveChildCount()).toBe(0);
  }, 15_000);

  it('a hanging CLI is killed at the phase timeout and reported as a timeout', async () => {
    const pids: number[] = [];
    const t = Date.now();
    const { result, error } = await collect(
      runSpeedtest({
        adapter: fakeHarnessAdapter(() => [{ pid: true }, { out: { t: 'text', v: 'partial answer' } }, { grandchild: 60 }, { hang: true }], pids),
        mode: 'quick',
        timeoutMs: 700,
        noHistory: true,
      })
    );
    expect(result).toBeUndefined();
    expect(isPhaseTimeoutError(error)).toBe(true);
    expect(Date.now() - t).toBeLessThan(4000);
    expect(pids).toHaveLength(1);
    await sleep(100);
    expect(() => process.kill(pids[0], 0)).toThrow();
    expect(liveChildCount()).toBe(0);
  }, 15_000);

  it('a CLI that exits non-zero mid-answer fails the run with its stderr', async () => {
    const { error, events } = await collect(
      runSpeedtest({
        adapter: fakeHarnessAdapter(() => [...streamSteps(5, 20), { err: 'Error: rate limit exceeded (429)\n' }, { exit: 1 }]),
        mode: 'quick',
        noHistory: true,
      })
    );
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as TargetFailedError).kind).toBe('rate_limit');
    expect((error as Error).message).toContain('rate limit exceeded');
    expect(events.at(-1)).toMatchObject({ type: 'run:error', failureKind: 'rate_limit' });
  }, 15_000);

  it('a missing binary is a normal per-target failure', async () => {
    const adapter = scripted((req) =>
      runNdjsonHarness({
        binaryPath: '/nonexistent/bin/codex',
        label: 'codex',
        req,
        buildArgs: () => ['exec'],
        createParser: () => () => [],
      })
    );
    const { error, events } = await collect(runSpeedtest({ adapter, mode: 'quick', noHistory: true }));
    expect((error as Error).message).toBe('codex: binary not found at /nonexistent/bin/codex');
    expect(events.at(-1)).toMatchObject({ type: 'run:error', kind: 'failed', failureKind: 'not_found' });
  });

  it('text harness: exit code 0 is success even when a grandchild keeps stdout open', async () => {
    const adapter = scripted(
      (req) =>
        runTextHarness({
          binaryPath: process.execPath,
          label: 'custom command',
          req,
          buildArgs: () => {
            const steps: FakeStep[] = [];
            for (let i = 0; i < 12; i++) steps.push({ out: `line ${i} of the answer` }, { wait: 100 });
            return fake.args([...steps, { grandchild: 20 }, { exit: 0 }]);
          },
        }),
      { category: 'custom' }
    );
    const t = Date.now();
    const { result, error } = await collect(runSpeedtest({ adapter, mode: 'quick', noHistory: true }));
    expect(error).toBeUndefined();
    expect(result!.summary.streaming).toBe(true);
    expect(result!.isolation).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(5000);
    expect(liveChildCount()).toBe(0);
  }, 15_000);
});
