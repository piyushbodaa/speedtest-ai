export type FailureKind = 'auth' | 'rate_limit' | 'not_found' | 'model' | 'other';

/**
 * A phase exceeded its time budget. `stage` tells whether the whole phase ran out of time or the
 * target never produced a first byte. Never converted into a result.
 */
export class PhaseTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly stage: 'phase' | 'first_byte';

  constructor(message: string, options: { timeoutMs: number; stage?: 'phase' | 'first_byte' }) {
    super(message);
    this.name = 'PhaseTimeoutError';
    this.timeoutMs = options.timeoutMs;
    this.stage = options.stage ?? 'phase';
  }
}

/** The user (or the embedding program) asked the run to stop. Never converted into a result. */
export class InterruptedError extends Error {
  // Also keeps the class structurally distinct, so type guards narrow the other errors correctly.
  readonly interrupted = true as const;

  constructor(message = 'Interrupted by user') {
    super(message);
    this.name = 'InterruptedError';
  }
}

/** The target itself failed: missing binary, auth, bad model, crash, wrong or empty answer. */
export class TargetFailedError extends Error {
  readonly kind: FailureKind;
  readonly exitCode?: number | null;
  readonly stderrTail?: string;

  constructor(
    message: string,
    options: { kind?: FailureKind; exitCode?: number | null; stderrTail?: string; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TargetFailedError';
    this.kind = options.kind ?? 'other';
    this.exitCode = options.exitCode;
    this.stderrTail = options.stderrTail;
  }
}

// Name checks instead of instanceof so the guards also hold across separately bundled copies
// (dist/cli.cjs and dist/index.js each carry their own class objects).
function hasName(err: unknown, name: string): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === name;
}

export function isPhaseTimeoutError(err: unknown): err is PhaseTimeoutError {
  return hasName(err, 'PhaseTimeoutError');
}

export function isInterruptedError(err: unknown): err is InterruptedError {
  return hasName(err, 'InterruptedError');
}

export function isTargetFailedError(err: unknown): err is TargetFailedError {
  return hasName(err, 'TargetFailedError');
}

/** True for the two errors that mean "the run was cut short", as opposed to "the target failed". */
export function isAbortError(err: unknown): err is PhaseTimeoutError | InterruptedError {
  return isPhaseTimeoutError(err) || isInterruptedError(err);
}

/**
 * Maps an aborted signal to the typed error to throw. A reason that is already a
 * PhaseTimeoutError or InterruptedError is passed through; anything else counts as a user
 * interrupt, because the only timer that aborts a phase sets a PhaseTimeoutError itself.
 */
export function abortErrorFromSignal(signal: AbortSignal): PhaseTimeoutError | InterruptedError {
  const reason: unknown = signal.reason;
  if (isPhaseTimeoutError(reason) || isInterruptedError(reason)) return reason;
  if (reason instanceof Error && reason.name !== 'AbortError' && reason.message) {
    return new InterruptedError(reason.message);
  }
  return new InterruptedError();
}

const AUTH_RE =
  /not logged in|please (?:log ?in|sign ?in|run .{0,24}login)|login required|logged out|unauthori[sz]ed|\b401\b|invalid (?:api|x-api)[ -]?key|missing api key|authentication (?:failed|error|required)|oauth token (?:has )?expired|token (?:has )?expired/i;
const RATE_LIMIT_RE =
  /rate[ -]?limit|\b429\b|too many requests|usage limit|quota (?:exceeded|exhausted)|out of credits|insufficient credits/i;
const MODEL_RE =
  /issue with the selected model|model [`'"]?[\w.:\/-]+[`'"]? (?:does not exist|is not supported|not found|is not available)|does not exist or you lack access|invalid model|unknown model|couldn't set model|model is not supported/i;
const NOT_FOUND_RE = /\bENOENT\b|command not found|no such file or directory/i;

/** Narrow, conservative classification of a failure message or stderr tail. */
export function classifyFailureKind(text: string | undefined): FailureKind {
  if (!text) return 'other';
  if (MODEL_RE.test(text)) return 'model';
  if (AUTH_RE.test(text)) return 'auth';
  if (RATE_LIMIT_RE.test(text)) return 'rate_limit';
  if (NOT_FOUND_RE.test(text)) return 'not_found';
  return 'other';
}

/** Normalises anything thrown by an adapter into one of the three typed errors. */
export function toTypedError(
  err: unknown
): PhaseTimeoutError | InterruptedError | TargetFailedError {
  if (isPhaseTimeoutError(err) || isInterruptedError(err) || isTargetFailedError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new TargetFailedError(message || 'Target failed', {
    kind: classifyFailureKind(message),
    cause: err,
  });
}
