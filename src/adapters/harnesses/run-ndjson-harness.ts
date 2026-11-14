import { StringDecoder } from 'node:string_decoder';
import {
  abortErrorFromSignal,
  classifyFailureKind,
  PhaseTimeoutError,
  TargetFailedError,
  toTypedError,
} from '../../core/errors.js';
import type { AdapterInvokeRequest, AdapterStreamChunk } from '../../types.js';
import { NdjsonLineDecoder } from '../utils/ndjson.js';
import { type ChildExit, spawnIsolated, withPhaseSandbox } from '../utils/spawn.js';

export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 30_000;

/** How long stdout may stay open after the CLI itself exited (a grandchild holding the pipe). */
const STDOUT_LINGER_AFTER_EXIT_MS = 250;
const EXIT_WAIT_AFTER_EOF_MS = 2000;

/** What a parser can do besides returning chunks. */
export interface HarnessIo {
  /** `performance.now()` just before the spawn. */
  readonly spawnedAtMs: number;
  /**
   * Writes one line to the child's stdin: a string is sent as is, anything else as JSON.
   * Returns false when stdin is not piped or already closed.
   */
  send(message: unknown): boolean;
  /** Closes the child's stdin. */
  endInput(): void;
  /** Stops the child and makes the harness throw `error`. */
  fail(error: Error): void;
  /**
   * Fails the run with `makeError()` unless the returned cancel function is called within `ms`.
   * Pending deadlines are dropped automatically when the run ends.
   */
  setDeadline(ms: number, makeError: () => Error): () => void;
  stderrTail(): string;
}

/** Maps one decoded stdout event to chunks. May throw a TargetFailedError for an error event. */
export type HarnessEventParser = (event: unknown) => AdapterStreamChunk[];

export interface HarnessRunOptions {
  binaryPath: string;
  /** Short target name used in error messages ("claude", "codex"). */
  label: string;
  req: AdapterInvokeRequest;
  buildArgs: (effectiveCwd: string) => string[];
  /**
   * 'ndjson' (default): stdout is JSON lines, each passed to the parser.
   * 'text': raw stdout becomes `text` chunks (plain print-mode CLIs, custom commands).
   */
  format?: 'ndjson' | 'text';
  /** Required for 'ndjson'. Called once per spawn, after the process started. */
  createParser?: (io: HarnessIo, effectiveCwd: string) => HarnessEventParser;
  /**
   * The adapter's success contract.
   * 'event' (default for ndjson): the parser must emit a `terminal` chunk; the harness then stops
   *   reading and kills the process group without waiting for teardown. No terminal chunk = failure.
   * 'exit' (default for text): the process must exit with code 0.
   */
  terminal?: 'event' | 'exit';
  /** 'pipe' enables `io.send` for bidirectional protocols. Default 'ignore'. */
  stdin?: 'ignore' | 'pipe';
  /** Called right after the spawn; the place to write the first stdin messages. */
  onSpawn?: (io: HarnessIo, effectiveCwd: string) => void;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  /**
   * Fail early when the child printed nothing at all for this long. Default for 'ndjson':
   * min(req.timeoutMs, 30 s). Default for 'text': off (a plain CLI may print only at the end).
   */
  firstByteTimeoutMs?: number | false;
}

function formatStderrTail(tail: string): string {
  const lines = tail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3);
  const joined = lines.join(' | ');
  return joined.length > 400 ? `...${joined.slice(-400)}` : joined;
}

function describeExit(exit: ChildExit | undefined): string {
  if (!exit) return 'did not exit';
  if (exit.signal) return `killed by ${exit.signal}`;
  return `exit code ${exit.code ?? 'unknown'}`;
}

function spawnFailure(label: string, binaryPath: string, error: NodeJS.ErrnoException): TargetFailedError {
  if (error.code === 'ENOENT') {
    return new TargetFailedError(`${label}: binary not found at ${binaryPath}`, {
      kind: 'not_found',
      cause: error,
    });
  }
  if (error.code === 'EACCES') {
    return new TargetFailedError(`${label}: ${binaryPath} is not executable`, {
      kind: 'not_found',
      cause: error,
    });
  }
  return new TargetFailedError(`${label}: failed to start ${binaryPath}: ${error.message}`, {
    kind: 'not_found',
    cause: error,
  });
}

async function* runInDirectory(
  options: HarnessRunOptions,
  effectiveCwd: string
): AsyncGenerator<AdapterStreamChunk, void, unknown> {
  const { req, label } = options;
  const format = options.format ?? 'ndjson';
  const terminalMode = options.terminal ?? (format === 'ndjson' ? 'event' : 'exit');
  if (format === 'ndjson' && !options.createParser) {
    throw new Error(`${label}: createParser is required for the ndjson format`);
  }
  if (req.signal.aborted) throw abortErrorFromSignal(req.signal);

  const args = options.buildArgs(effectiveCwd);

  // Yielded before the spawn call so the runner's t0 is the moment the process is started.
  yield { kind: 'start' };

  const proc = spawnIsolated(options.binaryPath, args, {
    cwd: effectiveCwd,
    signal: req.signal,
    env: options.env,
    shell: options.shell,
    stdin: options.stdin,
  });

  const pending: unknown[] = [];
  let stdoutEnded = false;
  let sawOutput = false;
  let exitInfo: ChildExit | undefined;
  let failure: Error | undefined;
  let finished = false;
  let wake: (() => void) | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const notify = () => {
    const fn = wake;
    wake = undefined;
    fn?.();
  };
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const io: HarnessIo = {
    spawnedAtMs: proc.spawnedAtMs,
    send: (message) => proc.write(typeof message === 'string' ? message : JSON.stringify(message)),
    endInput: () => proc.endInput(),
    fail: (error) => {
      if (!failure) failure = error;
      notify();
    },
    setDeadline: (ms, makeError) => {
      const timer = later(ms, () => {
        if (!finished) io.fail(makeError());
      });
      return () => {
        clearTimeout(timer);
        timers.delete(timer);
      };
    },
    stderrTail: () => proc.getStderrTail(),
  };

  const lineDecoder = format === 'ndjson' ? new NdjsonLineDecoder() : undefined;
  const textDecoder = format === 'text' ? new StringDecoder('utf8') : undefined;

  const onData = (chunk: Buffer | string) => {
    sawOutput = true;
    if (lineDecoder) {
      pending.push(...lineDecoder.push(chunk));
    } else {
      const text = typeof chunk === 'string' ? chunk : textDecoder!.write(chunk);
      if (text) pending.push(text);
    }
    notify();
  };
  const onEnd = () => {
    if (stdoutEnded) return;
    stdoutEnded = true;
    if (lineDecoder) pending.push(...lineDecoder.flush());
    else {
      const rest = textDecoder!.end();
      if (rest) pending.push(rest);
    }
    notify();
  };
  proc.stdout.on('data', onData);
  proc.stdout.once('end', onEnd);
  proc.stdout.once('close', onEnd);
  void proc.waitForProcessExit().then((exit) => {
    exitInfo = exit;
    if (exit.error) onEnd();
    // A descendant can keep the pipe open long after the CLI is gone; do not wait for it.
    else later(STDOUT_LINGER_AFTER_EXIT_MS, onEnd);
    notify();
  });

  const onAbort = () => notify();
  req.signal.addEventListener('abort', onAbort, { once: true });

  const firstByteMs =
    options.firstByteTimeoutMs === false
      ? undefined
      : (options.firstByteTimeoutMs ??
        (format === 'ndjson'
          ? Math.min(req.timeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_FIRST_BYTE_TIMEOUT_MS)
          : undefined));
  if (firstByteMs !== undefined) {
    later(firstByteMs, () => {
      if (sawOutput || finished || failure) return;
      const tail = formatStderrTail(proc.getStderrTail());
      const kind = classifyFailureKind(tail);
      const seconds = Math.round(firstByteMs / 100) / 10;
      const message = `${label} produced no output within ${seconds}s${tail ? `: ${tail}` : ''}`;
      io.fail(
        kind === 'other'
          ? new PhaseTimeoutError(message, { timeoutMs: firstByteMs, stage: 'first_byte' })
          : new TargetFailedError(message, { kind, stderrTail: tail })
      );
    });
  }

  let sawTerminal = false;
  let announcedReady = false;

  try {
    const parse = options.createParser?.(io, effectiveCwd);
    options.onSpawn?.(io, effectiveCwd);

    reading: while (true) {
      if (req.signal.aborted) throw abortErrorFromSignal(req.signal);
      if (failure) throw failure;

      if (pending.length > 0) {
        const event = pending.shift();
        if (!announcedReady) {
          announcedReady = true;
          yield { kind: 'meta' };
        }
        const chunks: AdapterStreamChunk[] = parse
          ? parse(event)
          : [{ kind: 'text', text: event as string }];
        for (const chunk of chunks) {
          yield chunk;
          if (chunk.kind === 'terminal') {
            sawTerminal = true;
            break reading;
          }
        }
        continue;
      }

      if (stdoutEnded) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }

    if (sawTerminal) return;

    if (!exitInfo) {
      await Promise.race([
        proc.waitForProcessExit(),
        new Promise<void>((resolve) => later(EXIT_WAIT_AFTER_EOF_MS, resolve)),
        new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
    }
    if (req.signal.aborted) throw abortErrorFromSignal(req.signal);
    if (failure) throw failure;

    if (exitInfo?.error) throw spawnFailure(label, options.binaryPath, exitInfo.error);

    const tail = formatStderrTail(proc.getStderrTail());
    if (terminalMode === 'exit') {
      if (exitInfo && exitInfo.code === 0) return;
      throw new TargetFailedError(
        `${label} failed (${describeExit(exitInfo)})${tail ? `: ${tail}` : ''}`,
        { kind: classifyFailureKind(tail), exitCode: exitInfo?.code ?? null, stderrTail: tail }
      );
    }
    throw new TargetFailedError(
      `${label} ended without its final event (${describeExit(exitInfo)})${tail ? `: ${tail}` : ''}`,
      { kind: classifyFailureKind(tail), exitCode: exitInfo?.code ?? null, stderrTail: tail }
    );
  } catch (err) {
    // An abort always wins: a kill-induced parser or pipe error must not hide a timeout or Ctrl-C.
    if (req.signal.aborted) throw abortErrorFromSignal(req.signal);
    throw toTypedError(err);
  } finally {
    finished = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    req.signal.removeEventListener('abort', onAbort);
    proc.stdout.off('data', onData);
    proc.cleanup();
  }
}

/**
 * Shared process runner for every harness adapter: spawn in a sandbox directory, optionally
 * converse over stdin, turn stdout into chunks, and enforce the adapter's success contract.
 *
 * Emits `{kind:'start'}` at spawn and `{kind:'meta'}` at the first stdout event, then the
 * parser's chunks. Throws PhaseTimeoutError / InterruptedError when `req.signal` aborts (never a
 * partial result) and TargetFailedError for everything else.
 */
export async function* runNdjsonHarness(
  options: HarnessRunOptions
): AsyncGenerator<AdapterStreamChunk, void, unknown> {
  const gen = await withPhaseSandbox<AdapterStreamChunk>(
    options.req.cwd,
    options.req.enableReadTool,
    (effectiveCwd) => runInDirectory(options, effectiveCwd)
  );
  yield* gen;
}

/** Plain-text variant: raw stdout chunks are the visible text and exit code 0 is success. */
export function runTextHarness(
  options: Omit<HarnessRunOptions, 'format' | 'createParser' | 'terminal'>
): AsyncGenerator<AdapterStreamChunk, void, unknown> {
  return runNdjsonHarness({ ...options, format: 'text', terminal: 'exit' });
}
