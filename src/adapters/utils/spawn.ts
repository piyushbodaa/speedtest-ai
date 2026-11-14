import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable, type Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { buildSafeEnv } from '../../core/detect.js';
import { IS_WINDOWS, killTree, spawnTarget, treeAlive } from '../../core/platform.js';

/** SIGTERM goes to the whole process group first; SIGKILL follows after this long. */
export const KILL_GRACE_MS = 1500;

export interface ChildExit {
  /** Exit code, or null when the child was killed by a signal or never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be spawned at all (ENOENT, EACCES, ...). */
  error?: NodeJS.ErrnoException;
}

export interface SpawnOptions {
  cwd: string;
  /** Aborting kills the child's process group. */
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  /** 'pipe' gives a writable stdin (see `write` / `endInput`); the default 'ignore' gives none. */
  stdin?: 'ignore' | 'pipe';
}

export interface SpawnedHandle {
  child: ChildProcess;
  pid: number | undefined;
  /** `performance.now()` taken immediately before the spawn call: t0 of the timing model. */
  spawnedAtMs: number;
  stdout: Readable;
  stderr: Readable;
  stdin: Writable | null;
  /** Writes one line to stdin (a trailing newline is added). False when stdin is closed or absent. */
  write: (line: string) => boolean;
  endInput: () => void;
  getStderrTail: () => string;
  /** Resolves when the process is gone and its pipes are closed. Never rejects. */
  waitForExit: () => Promise<ChildExit>;
  /**
   * Resolves as soon as the process itself has exited, even while a descendant still holds its
   * stdout open (in which case `waitForExit` would keep waiting). Never rejects.
   */
  waitForProcessExit: () => Promise<ChildExit>;
  /** True once `kill()` (or an abort) asked the child to stop. */
  readonly killRequested: boolean;
  /** SIGTERM to the process group, SIGKILL after KILL_GRACE_MS, pipes destroyed. Idempotent. */
  kill: () => void;
  /** Detaches the abort listener and kills the child if it is still running. */
  cleanup: () => void;
}

interface LiveChild {
  pid: number;
  killRequested: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  destroyStreams: () => void;
}

const liveChildren = new Set<LiveChild>();
let exitHookInstalled = false;

const signalGroup = killTree;
const groupAlive = treeAlive;

function forget(entry: LiveChild): void {
  if (entry.killTimer) clearTimeout(entry.killTimer);
  entry.killTimer = undefined;
  liveChildren.delete(entry);
}

function requestKill(entry: LiveChild): void {
  if (entry.killRequested) return;
  entry.killRequested = true;
  entry.destroyStreams();
  if (!signalGroup(entry.pid, 'SIGTERM')) {
    forget(entry);
    return;
  }
  entry.killTimer = setTimeout(() => {
    entry.killTimer = undefined;
    signalGroup(entry.pid, 'SIGKILL');
    liveChildren.delete(entry);
  }, KILL_GRACE_MS);
  entry.killTimer.unref();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Detached children are outside the terminal's foreground group, so nothing else reaps them
  // when this process goes away.
  process.on('exit', () => killAllChildren({ force: true }));
}

/**
 * Stops every child this module spawned. Call it from SIGINT / SIGTERM / SIGHUP handlers
 * (graceful: SIGTERM, then SIGKILL after KILL_GRACE_MS) and with `force: true` when the process
 * is about to exit and cannot wait (immediate SIGKILL to each group).
 */
export function killAllChildren(options: { force?: boolean } = {}): void {
  for (const entry of [...liveChildren]) {
    if (options.force) {
      entry.killRequested = true;
      entry.destroyStreams();
      signalGroup(entry.pid, 'SIGKILL');
      forget(entry);
    } else {
      requestKill(entry);
    }
  }
}

export function liveChildCount(): number {
  return liveChildren.size;
}

/**
 * Waits (off the clock) until every spawned child is gone or `maxWaitMs` passed. Used between
 * phases and targets so that one CLI's teardown does not overlap the next measurement.
 */
export async function settleChildren(maxWaitMs = KILL_GRACE_MS + 500): Promise<void> {
  const deadline = performance.now() + maxWaitMs;
  while (liveChildren.size > 0 && performance.now() < deadline) {
    for (const entry of [...liveChildren]) {
      if (!groupAlive(entry.pid)) forget(entry);
    }
    if (liveChildren.size === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function failedHandle(error: NodeJS.ErrnoException, spawnedAtMs: number): SpawnedHandle {
  const empty = () => Readable.from([]);
  const exit: ChildExit = { code: null, signal: null, error };
  return {
    child: undefined as unknown as ChildProcess,
    pid: undefined,
    spawnedAtMs,
    stdout: empty(),
    stderr: empty(),
    stdin: null,
    write: () => false,
    endInput: () => {},
    getStderrTail: () => '',
    waitForExit: () => Promise.resolve(exit),
    waitForProcessExit: () => Promise.resolve(exit),
    killRequested: false,
    kill: () => {},
    cleanup: () => {},
  };
}

/**
 * Spawns `cmd` in its own process group with a scrubbed environment. Spawn failures are reported
 * through `waitForExit()` (`error` set), never as an unhandled rejection or 'error' event.
 */
export function spawnIsolated(cmd: string, args: string[], opts: SpawnOptions): SpawnedHandle {
  installExitHook();
  const spawnedAtMs = performance.now();

  let child: ChildProcess;
  try {
    const target = opts.shell ? { file: cmd, args } : spawnTarget(cmd, args);
    child = spawn(target.file, target.args, {
      cwd: opts.cwd,
      env: buildSafeEnv(opts.env),
      stdio: [opts.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: opts.shell ?? false,
      // POSIX: the child leads its own process group so the whole group can be signalled.
      // Windows has no groups (taskkill walks the tree) and `detached` would open a console.
      detached: !IS_WINDOWS,
      windowsHide: true,
      windowsVerbatimArguments: 'windowsVerbatimArguments' in target ? target.windowsVerbatimArguments : undefined,
    });
  } catch (err) {
    return failedHandle(err as NodeJS.ErrnoException, spawnedAtMs);
  }

  const stdout = child.stdout as Readable;
  const stderr = child.stderr as Readable;
  const stdin = (child.stdin as Writable | null) ?? null;

  let stderrTail = '';
  const stderrDecoder = new StringDecoder('utf8');
  stderr.on('data', (chunk: Buffer | string) => {
    stderrTail += typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk);
    if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096);
  });
  // A destroyed pipe can still report EPIPE / premature-close; those are expected after a kill.
  stdout.on('error', () => {});
  stderr.on('error', () => {});
  stdin?.on('error', () => {});

  let exited = false;
  let spawnError: NodeJS.ErrnoException | undefined;
  let entry: LiveChild | undefined;

  if (typeof child.pid === 'number') {
    entry = {
      pid: child.pid,
      killRequested: false,
      destroyStreams: () => {
        stdout.destroy();
        stderr.destroy();
        if (stdin && !stdin.destroyed) stdin.destroy();
      },
    };
    liveChildren.add(entry);
  }

  const kill = () => {
    if (entry) requestKill(entry);
  };

  const onAbort = () => kill();
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  const exitPromise = new Promise<ChildExit>((resolve) => {
    let settled = false;
    const settle = (exit: ChildExit) => {
      if (settled) return;
      settled = true;
      exited = true;
      opts.signal?.removeEventListener('abort', onAbort);
      if (entry) {
        if (!entry.killRequested) {
          // The leader is gone; take any helpers it left in its group with it. Group only: the
          // leader's own pid has been reaped and must not be signalled again.
          signalGroup(entry.pid, 'SIGTERM', true);
          forget(entry);
        } else if (!groupAlive(entry.pid)) {
          forget(entry);
        }
      }
      resolve(exit);
    };
    child.once('error', (err: NodeJS.ErrnoException) => {
      // 'error' after a successful spawn (failed kill, IPC) is not a spawn failure.
      if (typeof child.pid !== 'number') {
        spawnError = err;
        settle({ code: null, signal: null, error: err });
      }
    });
    child.once('close', (code, signal) => {
      settle({ code, signal, error: spawnError });
    });
  });

  const processExitPromise = new Promise<ChildExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    void exitPromise.then(resolve);
  });

  return {
    child,
    pid: child.pid,
    spawnedAtMs,
    stdout,
    stderr,
    stdin,
    write: (line: string) => {
      if (!stdin || stdin.destroyed || !stdin.writable) return false;
      try {
        stdin.write(line.endsWith('\n') ? line : `${line}\n`);
        return true;
      } catch {
        return false;
      }
    },
    endInput: () => {
      if (stdin && !stdin.destroyed) stdin.end();
    },
    getStderrTail: () => stderrTail.trim(),
    waitForExit: () => exitPromise,
    waitForProcessExit: () => processExitPromise,
    get killRequested() {
      return entry?.killRequested ?? false;
    },
    kill,
    cleanup: () => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (!exited) kill();
    },
  };
}

/**
 * Runs `fn` in the tool-loop probe directory when the phase needs file access, otherwise in a
 * fresh empty temp directory that is removed afterwards (so the CLI finds no project context).
 */
export async function withPhaseSandbox<T>(
  reqCwd: string | undefined,
  enableReadTool: boolean | undefined,
  fn: (effectiveCwd: string) => AsyncGenerator<T, void, unknown>
): Promise<AsyncGenerator<T, void, unknown>> {
  if (enableReadTool && reqCwd) {
    return fn(reqCwd);
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'speedtest-ai-empty-'));
  async function* wrapped(): AsyncGenerator<T, void, unknown> {
    try {
      yield* fn(tmpDir);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return wrapped();
}
