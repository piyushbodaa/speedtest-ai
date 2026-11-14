/**
 * All terminal output of the CLI goes through this module so that a closed pipe (EPIPE) silences
 * further writes instead of crashing, and so the cursor / raw mode can be restored from any exit
 * path, including signal handlers and the process 'exit' hook.
 */

let outputClosed = false;
let cursorHidden = false;
let rawModeHeld = false;
let keyListener: ((data: Buffer) => void) | undefined;

export function isOutputClosed(): boolean {
  return outputClosed;
}

export function markOutputClosed(): void {
  outputClosed = true;
}

export function out(text: string): void {
  if (outputClosed) return;
  try {
    process.stdout.write(text);
  } catch {
    outputClosed = true;
  }
}

export function err(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // Nothing left to report to.
  }
}

export interface TermSize {
  columns: number;
  rows: number;
  isTTY: boolean;
}

export function termSize(): TermSize {
  const isTTY = Boolean(process.stdout.isTTY);
  const columns = isTTY && process.stdout.columns ? process.stdout.columns : 80;
  const rows = isTTY && process.stdout.rows ? process.stdout.rows : 24;
  return { columns, rows, isTTY };
}

/**
 * Widest line the CLI may print. One less than the terminal so a full line never sits in the
 * auto-wrap column; a fixed 80 when the output is not a terminal.
 */
export function maxLineWidth(size: TermSize = termSize()): number {
  return size.isTTY ? Math.max(20, size.columns - 1) : 80;
}

/**
 * Escape sequence that blanks the `count` lines above the cursor and leaves the cursor on the first
 * of them. Line-by-line on purpose: "erase to end of screen" from the top row makes tmux copy the
 * whole screen into its scrollback.
 */
export function eraseLinesAbove(count: number): string {
  if (count <= 0) return '';
  return `\x1b[${count}A\r${'\x1b[2K\x1b[1B'.repeat(count)}\x1b[${count}A\r`;
}

export function hideCursor(): void {
  if (!process.stdout.isTTY || cursorHidden) return;
  cursorHidden = true;
  out('\x1b[?25l');
}

export function showCursor(): void {
  if (!cursorHidden) return;
  cursorHidden = false;
  try {
    process.stdout.write('\x1b[?25h');
  } catch {
    // The terminal is gone.
  }
}

/**
 * Raw mode for the live screens: typed keys are not echoed into the frame and Enter does not
 * scroll it. Ctrl-C then arrives as a byte, so `onInterrupt` stands in for SIGINT.
 */
export function holdRawInput(onInterrupt: () => void, onKey?: (data: Buffer) => void): void {
  const stdin = process.stdin;
  if (!stdin.isTTY || rawModeHeld) return;
  try {
    stdin.setRawMode(true);
  } catch {
    return;
  }
  rawModeHeld = true;
  keyListener = (data: Buffer) => {
    if (data.includes(0x03)) {
      onInterrupt();
      return;
    }
    onKey?.(data);
  };
  stdin.on('data', keyListener);
  stdin.resume();
}

export function releaseRawInput(): void {
  if (!rawModeHeld) return;
  rawModeHeld = false;
  const stdin = process.stdin;
  if (keyListener) stdin.off('data', keyListener);
  keyListener = undefined;
  try {
    stdin.setRawMode(false);
  } catch {
    // The terminal is gone.
  }
  stdin.pause();
}

/** Safe to call from anywhere, any number of times: puts the terminal back as it was found. */
export function restoreTerminal(): void {
  releaseRawInput();
  showCursor();
}
