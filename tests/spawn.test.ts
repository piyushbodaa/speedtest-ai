import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KILL_GRACE_MS,
  killAllChildren,
  liveChildCount,
  settleChildren,
  spawnIsolated,
} from '../src/adapters/utils/spawn.js';
import { NdjsonLineDecoder } from '../src/adapters/utils/ndjson.js';
import { createFakeCli, type FakeCli, type FakeStep, isAlive, waitUntil } from './helpers/fake-cli.js';

let fake: FakeCli;
beforeAll(() => {
  fake = createFakeCli();
});
afterAll(() => {
  killAllChildren({ force: true });
  fake.remove();
});

function start(steps: FakeStep[], extra: { signal?: AbortSignal; stdin?: 'pipe' } = {}) {
  const handle = spawnIsolated(process.execPath, fake.args(steps), { cwd: fake.dir, ...extra });
  const decoder = new NdjsonLineDecoder();
  const events: any[] = [];
  handle.stdout.on('data', (chunk) => events.push(...decoder.push(chunk)));
  return { handle, events };
}

describe('spawnIsolated', () => {
  it('reports a missing binary through waitForExit instead of an unhandled rejection', async () => {
    const handle = spawnIsolated('/nonexistent/dir/agent-cli', ['-p', 'hi'], { cwd: fake.dir });
    const exit = await handle.waitForExit();
    expect(exit.error?.code).toBe('ENOENT');
    expect(exit.code).toBeNull();
    expect(handle.pid).toBeUndefined();
    expect(liveChildCount()).toBe(0);
  });

  it('reports a missing working directory the same way', async () => {
    const handle = spawnIsolated(process.execPath, ['-e', '0'], { cwd: '/nonexistent/dir/cwd' });
    const exit = await handle.waitForExit();
    expect(exit.error).toBeDefined();
  });

  it('returns the exit code and stderr tail of a normal run', async () => {
    const { handle, events } = start([{ out: { a: 1 } }, { err: 'warn: something\n' }, { exit: 3 }]);
    const exit = await handle.waitForExit();
    expect(exit.code).toBe(3);
    expect(exit.error).toBeUndefined();
    expect(events).toEqual([{ a: 1 }]);
    expect(handle.getStderrTail()).toBe('warn: something');
    expect(liveChildCount()).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('kills the whole process group, including a grandchild that holds stdout', async () => {
    const { handle, events } = start([{ pid: true }, { grandchild: 60 }, { hang: true }]);
    expect(await waitUntil(() => events.length >= 2, 3000)).toBe(true);
    const childPid = events[0].pid as number;
    const grandchildPid = events[1].grandchild as number;
    expect(isAlive(childPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    const t = Date.now();
    handle.kill();
    expect(handle.killRequested).toBe(true);
    const exit = await handle.waitForExit();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(exit.signal).toBe('SIGTERM');
    expect(await waitUntil(() => !isAlive(grandchildPid), 1000)).toBe(true);
    expect(isAlive(childPid)).toBe(false);
    await settleChildren();
    expect(liveChildCount()).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const { handle, events } = start([{ ignoreSigterm: true }, { pid: true }, { hang: true }]);
    expect(await waitUntil(() => events.length >= 1, 3000)).toBe(true);
    const pid = events[0].pid as number;

    const t = Date.now();
    handle.kill();
    const exit = await handle.waitForExit();
    const elapsed = Date.now() - t;
    expect(exit.signal).toBe('SIGKILL');
    expect(elapsed).toBeGreaterThanOrEqual(KILL_GRACE_MS - 100);
    expect(elapsed).toBeLessThan(KILL_GRACE_MS + 1500);
    expect(isAlive(pid)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('kills on abort', async () => {
    const controller = new AbortController();
    const { handle, events } = start([{ pid: true }, { hang: true }], { signal: controller.signal });
    expect(await waitUntil(() => events.length >= 1, 3000)).toBe(true);
    controller.abort(new Error('stop'));
    const exit = await handle.waitForExit();
    expect(exit.signal).toBe('SIGTERM');
    expect(isAlive(events[0].pid)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('killAllChildren({force}) removes every live child immediately', async () => {
    const a = start([{ ignoreSigterm: true }, { pid: true }, { hang: true }]);
    const b = start([{ pid: true }, { grandchild: 60 }, { hang: true }]);
    expect(await waitUntil(() => a.events.length >= 1 && b.events.length >= 2, 3000)).toBe(true);
    expect(liveChildCount()).toBe(2);

    killAllChildren({ force: true });
    expect(liveChildCount()).toBe(0);
    const pids = [a.events[0].pid, b.events[0].pid, b.events[1].grandchild] as number[];
    expect(await waitUntil(() => pids.every((pid) => !isAlive(pid)), 1000)).toBe(true);
    expect((await a.handle.waitForExit()).signal).toBe('SIGKILL');
  });

  it('supports a line-based conversation over stdin', async () => {
    const { handle, events } = start([{ echoStdin: true }], { stdin: 'pipe' });
    expect(handle.write(JSON.stringify({ id: 1, method: 'initialize' }))).toBe(true);
    expect(await waitUntil(() => events.length >= 1, 3000)).toBe(true);
    expect(events[0]).toEqual({ echo: { id: 1, method: 'initialize' } });
    handle.write('{"cmd":"finish"}\n');
    expect(await waitUntil(() => events.length >= 2, 3000)).toBe(true);
    expect(events[1]).toEqual({ t: 'done' });
    handle.endInput();
    const exit = await handle.waitForExit();
    expect(exit.code).toBe(0);
    expect(handle.write('late')).toBe(false);
  });

  it('has no writable stdin by default', async () => {
    const { handle } = start([{ exit: 0 }]);
    expect(handle.stdin).toBeNull();
    expect(handle.write('x')).toBe(false);
    await handle.waitForExit();
  });
});
