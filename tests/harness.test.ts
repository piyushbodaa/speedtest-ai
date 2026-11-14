import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type HarnessIo,
  type HarnessRunOptions,
  runNdjsonHarness,
  runTextHarness,
} from '../src/adapters/harnesses/run-ndjson-harness.js';
import { killAllChildren, liveChildCount, settleChildren } from '../src/adapters/utils/spawn.js';
import {
  InterruptedError,
  isInterruptedError,
  isPhaseTimeoutError,
  isTargetFailedError,
  PhaseTimeoutError,
  TargetFailedError,
} from '../src/core/errors.js';
import type { AdapterInvokeRequest, AdapterStreamChunk } from '../src/types.js';
import { createFakeCli, type FakeCli, type FakeStep, isAlive, sleep, waitUntil } from './helpers/fake-cli.js';

let fake: FakeCli;
beforeAll(() => {
  fake = createFakeCli();
});
afterAll(() => {
  killAllChildren({ force: true });
  fake.remove();
});

/** Fake protocol: {t:'text',v} | {t:'think',v} | {t:'usage',out} | {t:'done'} | {t:'error',message}. */
function fakeParser(_io: HarnessIo) {
  return (event: unknown): AdapterStreamChunk[] => {
    const ev = event as Record<string, any>;
    if (ev.t === 'init') return [{ kind: 'init', model: ev.model }];
    if (ev.t === 'text') return [{ kind: 'text', text: ev.v }];
    if (ev.t === 'think') return [{ kind: 'thinking', text: ev.v }];
    if (ev.t === 'usage') return [{ kind: 'usage', outputTokens: ev.out }];
    if (ev.t === 'done') return [{ kind: 'terminal', outputTokens: ev.out }];
    if (ev.t === 'error') throw new TargetFailedError(`fake: ${ev.message}`, { kind: 'model' });
    return [];
  };
}

function request(signal?: AbortSignal, timeoutMs?: number): AdapterInvokeRequest {
  return { phase: 'download', prompt: 'hi', signal: signal ?? new AbortController().signal, timeoutMs };
}

function harness(
  steps: FakeStep[],
  overrides: Partial<HarnessRunOptions> = {}
): AsyncGenerator<AdapterStreamChunk, void, unknown> {
  return runNdjsonHarness({
    binaryPath: process.execPath,
    label: 'fake',
    req: request(),
    buildArgs: () => fake.args(steps),
    createParser: fakeParser,
    ...overrides,
  });
}

async function drain(gen: AsyncGenerator<AdapterStreamChunk, void, unknown>) {
  const chunks: AdapterStreamChunk[] = [];
  let error: unknown;
  const startedAt = Date.now();
  try {
    for await (const chunk of gen) chunks.push(chunk);
  } catch (err) {
    error = err;
  }
  return { chunks, error, elapsedMs: Date.now() - startedAt };
}

const kinds = (chunks: AdapterStreamChunk[]) => chunks.map((c) => c.kind);
const text = (chunks: AdapterStreamChunk[]) =>
  chunks.filter((c) => c.kind === 'text').map((c) => c.text).join('');

describe('runNdjsonHarness', () => {
  it('emits start, ready marker, parsed chunks and stops at the terminal event without waiting for exit', async () => {
    const { chunks, error, elapsedMs } = await drain(
      harness([
        { pid: true },
        { out: { t: 'init', model: 'fake-1' } },
        { out: 'plain diagnostic line' },
        { out: { t: 'text', v: 'hello ' } },
        { wait: 50 },
        { out: { t: 'text', v: 'world' } },
        { out: { t: 'done', out: 7 } },
        // A real CLI needs 0.5-3 s to tear down after its final event; that must not be waited for.
        { wait: 5000 },
        { out: { t: 'text', v: ' NEVER' } },
      ])
    );
    expect(error).toBeUndefined();
    expect(kinds(chunks)).toEqual(['start', 'meta', 'init', 'text', 'text', 'terminal']);
    expect(text(chunks)).toBe('hello world');
    expect(chunks.at(-1)).toMatchObject({ kind: 'terminal', outputTokens: 7 });
    expect(elapsedMs).toBeLessThan(2000);
    await settleChildren();
    expect(liveChildCount()).toBe(0);
  });

  it('fails when the process exits non-zero before the terminal event, with the stderr tail', async () => {
    const { chunks, error } = await drain(
      harness([
        { out: { t: 'text', v: 'partial ' } },
        { err: 'API Error: 529 overloaded\n' },
        { exit: 1 },
      ])
    );
    expect(text(chunks)).toBe('partial ');
    expect(isTargetFailedError(error)).toBe(true);
    const failed = error as TargetFailedError;
    expect(failed.message).toContain('fake ended without its final event (exit code 1)');
    expect(failed.message).toContain('529 overloaded');
    expect(failed.exitCode).toBe(1);
  });

  it('fails when the process exits 0 but never sent the terminal event', async () => {
    const { error } = await drain(harness([{ out: { t: 'text', v: 'truncated' } }, { exit: 0 }]));
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as Error).message).toContain('without its final event (exit code 0)');
  });

  it('classifies an auth failure from stderr', async () => {
    const { error } = await drain(harness([{ err: 'Error: Not logged in. Please run /login\n' }, { exit: 1 }]));
    expect((error as TargetFailedError).kind).toBe('auth');
  });

  it('propagates an error raised by the parser and stops the child', async () => {
    const { error, elapsedMs } = await drain(
      harness([{ pid: true }, { out: { t: 'error', message: 'bad model' } }, { hang: true }])
    );
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as TargetFailedError).message).toBe('fake: bad model');
    expect((error as TargetFailedError).kind).toBe('model');
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('turns a missing binary into a per-target error', async () => {
    const { chunks, error } = await drain(
      harness([], { binaryPath: '/nonexistent/bin/claude', label: 'claude', buildArgs: () => ['-p', 'x'] })
    );
    expect(kinds(chunks)).toEqual(['start']);
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as TargetFailedError).kind).toBe('not_found');
    expect((error as Error).message).toBe('claude: binary not found at /nonexistent/bin/claude');
  });

  it('throws the timeout error (not a partial result) when aborted mid-stream', async () => {
    const controller = new AbortController();
    const steps: FakeStep[] = [{ pid: true }];
    for (let i = 0; i < 100; i++) steps.push({ out: { t: 'text', v: `tok${i} ` } }, { wait: 50 });
    steps.push({ out: { t: 'done' } });

    const gen = harness(steps, { req: request(controller.signal) });
    setTimeout(
      () => controller.abort(new PhaseTimeoutError('fake: download phase timed out after 1s', { timeoutMs: 400 })),
      400
    );
    const { chunks, error, elapsedMs } = await drain(gen);
    expect(text(chunks).length).toBeGreaterThan(0);
    expect(isPhaseTimeoutError(error)).toBe(true);
    expect((error as Error).message).toContain('timed out');
    expect(elapsedMs).toBeLessThan(1500);
  });

  it('throws InterruptedError on a user abort, even when stderr has content', async () => {
    const controller = new AbortController();
    const gen = harness([{ err: 'warming up\n' }, { out: { t: 'text', v: 'a' } }, { hang: true }], {
      req: request(controller.signal),
    });
    setTimeout(() => controller.abort(new InterruptedError()), 300);
    const { error } = await drain(gen);
    expect(isInterruptedError(error)).toBe(true);
    expect((error as Error).message).toBe('Interrupted by user');
  });

  it('returns promptly on abort when a grandchild holds stdout open, and kills the whole group', async () => {
    const controller = new AbortController();
    const pids: number[] = [];
    const gen = runNdjsonHarness({
      binaryPath: process.execPath,
      label: 'fake',
      req: request(controller.signal),
      buildArgs: () => fake.args([{ pid: true }, { grandchild: 60 }, { hang: true }]),
      createParser: () => (event) => {
        const ev = event as Record<string, number>;
        if (ev.pid) pids.push(ev.pid);
        if (ev.grandchild) pids.push(ev.grandchild);
        return [];
      },
    });
    setTimeout(() => controller.abort(new PhaseTimeoutError('timed out', { timeoutMs: 500 })), 500);
    const { error, elapsedMs } = await drain(gen);
    expect(isPhaseTimeoutError(error)).toBe(true);
    expect(elapsedMs).toBeLessThan(1500);
    expect(pids).toHaveLength(2);
    expect(await waitUntil(() => pids.every((pid) => !isAlive(pid)), 2500)).toBe(true);
  });

  it('does not wait for a grandchild that keeps stdout open after the CLI exited', async () => {
    const { chunks, error, elapsedMs } = await drain(
      harness([{ grandchild: 20 }, { out: { t: 'text', v: 'x' } }, { out: { t: 'done' } }, { exit: 0 }])
    );
    expect(error).toBeUndefined();
    expect(kinds(chunks)).toContain('terminal');
    expect(elapsedMs).toBeLessThan(2000);
  });

  it.skipIf(process.platform === 'win32')('kills a child that ignores SIGTERM after the terminal event', async () => {
    let pid = 0;
    const gen = runNdjsonHarness({
      binaryPath: process.execPath,
      label: 'fake',
      req: request(),
      buildArgs: () => fake.args([{ ignoreSigterm: true }, { pid: true }, { out: { t: 'done' } }, { hang: true }]),
      createParser: (io) => {
        const inner = fakeParser(io);
        return (event) => {
          const ev = event as Record<string, number>;
          if (ev.pid) pid = ev.pid;
          return inner(event);
        };
      },
    });
    const { error, elapsedMs } = await drain(gen);
    expect(error).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1000);
    expect(isAlive(pid)).toBe(true);
    expect(await waitUntil(() => !isAlive(pid), 3000)).toBe(true);
  });

  it('fails early when the CLI prints nothing at all (first-byte watchdog)', async () => {
    const { chunks, error, elapsedMs } = await drain(harness([{ hang: true }], { firstByteTimeoutMs: 400 }));
    expect(kinds(chunks)).toEqual(['start']);
    expect(isPhaseTimeoutError(error)).toBe(true);
    expect((error as PhaseTimeoutError).stage).toBe('first_byte');
    expect((error as Error).message).toContain('fake produced no output within 0.4s');
    expect(elapsedMs).toBeLessThan(1500);
  });

  it('caps the first-byte watchdog at the phase timeout and reports a login prompt as an auth failure', async () => {
    const { error } = await drain(
      harness([{ err: 'Please log in to continue\n' }, { hang: true }], {
        req: request(undefined, 300),
      })
    );
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as TargetFailedError).kind).toBe('auth');
  });

  it('the watchdog does not fire once any event arrived', async () => {
    const { error, chunks } = await drain(
      harness([{ out: { t: 'init', model: 'm' } }, { wait: 700 }, { out: { t: 'text', v: 'late' } }, { out: { t: 'done' } }], {
        firstByteTimeoutMs: 300,
      })
    );
    expect(error).toBeUndefined();
    expect(text(chunks)).toBe('late');
  });

  it('drives a bidirectional stdin conversation and stops at the terminal event', async () => {
    const seen: unknown[] = [];
    const gen = runNdjsonHarness({
      binaryPath: process.execPath,
      label: 'fake-rpc',
      req: request(),
      stdin: 'pipe',
      buildArgs: () => fake.args([{ echoStdin: true }]),
      onSpawn: (io) => {
        io.send({ id: 1, method: 'initialize' });
      },
      createParser: (io) => (event) => {
        const ev = event as Record<string, any>;
        seen.push(ev);
        if (ev.echo?.id === 1) {
          io.send({ id: 2, method: 'turn/start' });
          return [{ kind: 'init', model: 'rpc-model' }];
        }
        if (ev.echo?.id === 2) {
          io.send('{"cmd":"finish"}');
          return [{ kind: 'text', text: 'streamed' }];
        }
        if (ev.t === 'done') return [{ kind: 'terminal' }];
        return [];
      },
    });
    const { chunks, error } = await drain(gen);
    expect(error).toBeUndefined();
    expect(kinds(chunks)).toEqual(['start', 'meta', 'init', 'text', 'terminal']);
    expect(seen).toHaveLength(3);
  });

  it('io.setDeadline fails the run unless cancelled', async () => {
    const failing = await drain(
      runNdjsonHarness({
        binaryPath: process.execPath,
        label: 'fake-rpc',
        req: request(),
        stdin: 'pipe',
        buildArgs: () => fake.args([{ pid: true }, { hang: true }]),
        createParser: (io) => {
          io.setDeadline(300, () => new TargetFailedError('app-server did not initialize within 0.3s'));
          return () => [];
        },
      })
    );
    expect((failing.error as Error).message).toBe('app-server did not initialize within 0.3s');
    expect(failing.elapsedMs).toBeLessThan(1500);

    const passing = await drain(
      runNdjsonHarness({
        binaryPath: process.execPath,
        label: 'fake-rpc',
        req: request(),
        buildArgs: () => fake.args([{ out: { t: 'init' } }, { wait: 500 }, { out: { t: 'done' } }]),
        createParser: (io) => {
          const cancel = io.setDeadline(250, () => new Error('should have been cancelled'));
          const inner = fakeParser(io);
          return (event) => {
            cancel();
            return inner(event);
          };
        },
      })
    );
    expect(passing.error).toBeUndefined();
  });

  it('runs in an empty temp directory that is removed afterwards', async () => {
    let cwd = '';
    const { error } = await drain(
      harness([{ out: { t: 'done' } }], {
        buildArgs: (dir) => {
          cwd = dir;
          return fake.args([{ out: { t: 'done' } }]);
        },
      })
    );
    expect(error).toBeUndefined();
    expect(cwd).toContain('speedtest-ai-empty-');
    const fs = await import('node:fs');
    expect(fs.existsSync(cwd)).toBe(false);
  });
});

describe('runTextHarness', () => {
  const textRun = (steps: FakeStep[], signal?: AbortSignal) =>
    runTextHarness({
      binaryPath: process.execPath,
      label: 'custom command',
      req: request(signal),
      buildArgs: () => fake.args(steps),
    });

  it('streams raw stdout as text and treats exit code 0 as success', async () => {
    const { chunks, error } = await drain(textRun([{ out: 'alpha beta' }, { wait: 30 }, { out: 'gamma' }, { exit: 0 }]));
    expect(error).toBeUndefined();
    expect(text(chunks)).toBe('alpha beta\ngamma\n');
    expect(kinds(chunks)).not.toContain('terminal');
  });

  it('keeps multi-byte characters split across writes', async () => {
    const bytes = [...Buffer.from('café €', 'utf8')];
    const { chunks } = await drain(
      textRun([{ bytes: bytes.slice(0, 4) }, { wait: 60 }, { bytes: bytes.slice(4, 7) }, { wait: 60 }, { bytes: bytes.slice(7) }, { exit: 0 }])
    );
    expect(text(chunks)).toBe('café €');
  });

  it('fails on a non-zero exit even after partial output', async () => {
    const { chunks, error } = await drain(textRun([{ out: 'partial' }, { err: 'boom\n' }, { exit: 3 }]));
    expect(text(chunks)).toBe('partial\n');
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as Error).message).toBe('custom command failed (exit code 3): boom');
  });

  it('throws on timeout instead of returning the partial text', async () => {
    const controller = new AbortController();
    const steps: FakeStep[] = [];
    for (let i = 0; i < 100; i++) steps.push({ out: 'alpha beta gamma' }, { wait: 50 });
    setTimeout(() => controller.abort(new PhaseTimeoutError('timed out', { timeoutMs: 300 })), 300);
    const { chunks, error } = await drain(textRun(steps, controller.signal));
    expect(text(chunks).length).toBeGreaterThan(0);
    expect(isPhaseTimeoutError(error)).toBe(true);
    await sleep(10);
  });
});
