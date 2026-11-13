import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { buildSafeEnv } from '../../core/detect.js';

export interface SpawnedHandle {
  child: ChildProcessByStdio<null, Readable, Readable>;
  getStderrTail: () => string;
  waitForExit: () => Promise<number | null>;
  cleanup: () => void;
}

export function spawnIsolated(
  cmd: string,
  args: string[],
  opts: { cwd: string; signal: AbortSignal; env?: NodeJS.ProcessEnv; shell?: boolean }
): SpawnedHandle {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: buildSafeEnv(opts.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: opts.shell ?? false,
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrTail += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (stderrTail.length > 4096) {
      stderrTail = stderrTail.slice(-4096);
    }
  });

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let exited = false;

  const onAbort = () => {
    if (exited) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore already exited
    }
    killTimer = setTimeout(() => {
      if (!exited) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore
        }
      }
    }, 500);
    killTimer.unref();
  };

  if (opts.signal.aborted) {
    onAbort();
  } else {
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.once('error', (err) => {
      exited = true;
      reject(err);
    });
    child.once('close', (code) => {
      exited = true;
      if (killTimer) clearTimeout(killTimer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve(code);
    });
  });

  const cleanup = () => {
    opts.signal.removeEventListener('abort', onAbort);
    if (killTimer) clearTimeout(killTimer);
    if (!exited) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore
      }
    }
  };

  return {
    child,
    getStderrTail: () => stderrTail.trim(),
    waitForExit: () => exitPromise,
    cleanup,
  };
}

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
