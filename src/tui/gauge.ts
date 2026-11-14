import { formatMs, formatTps } from '../core/card.js';
import type { BenchmarkMode, GaugeTick, PhaseId, PhaseResult } from '../types.js';
import { c, colorByTps, displayWidth, sanitizeInline, truncateAnsi } from './ansi.js';
import { brandPaint } from './brand.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** The live frame always has this many lines, so a redraw can move up by a known amount. */
export const FRAME_HEIGHT = 18;
export const MAX_FRAME_WIDTH = 68;
/** Below this size the live gauge is replaced by plain line output. */
export const MIN_FRAME_COLUMNS = 40;
export const MIN_FRAME_ROWS = 20;

/** The dial reads 0 on the left and this value on the right. */
export const DIAL_MAX_TPS = 200;

// The dial is drawn with braille characters: every terminal cell holds 2x4 dots, and because a
// cell is about twice as tall as it is wide the dots are close to square.
const DIAL_COLS = 36;
const DIAL_ROWS = 9;
const DIAL_OUTER = 34;
const DIAL_INNER = 30.5;
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

const BIG_DIGITS: Record<string, string[]> = {
  '0': ['█▀█', '█ █', '▀▀▀'],
  '1': ['▄█ ', ' █ ', '▀▀▀'],
  '2': ['▀▀█', '█▀▀', '▀▀▀'],
  '3': ['▀▀█', ' ▀█', '▀▀▀'],
  '4': ['█ █', '▀▀█', '  ▀'],
  '5': ['█▀▀', '▀▀█', '▀▀▀'],
  '6': ['█▀▀', '█▀█', '▀▀▀'],
  '7': ['▀▀█', '  █', '  ▀'],
  '8': ['█▀█', '█▀█', '▀▀▀'],
  '9': ['█▀█', '▀▀█', '▀▀▀'],
  '.': [' ', ' ', '▀'],
  '-': ['   ', '▀▀▀', '   '],
};

export function renderBigNumber(text: string): string[] {
  const rows = ['', '', ''];
  for (const ch of text) {
    const glyph = BIG_DIGITS[ch] ?? BIG_DIGITS['-'];
    for (let i = 0; i < 3; i++) rows[i] += (rows[i] ? ' ' : '') + glyph[i];
  }
  return rows;
}

/**
 * A half-circle speedometer, DIAL_ROWS lines of exactly DIAL_COLS cells: the arc fills from the
 * left in proportion to `tps`, and the reading sits inside it in large digits.
 */
export function renderSpeedometer(
  tps: number | null,
  maxScale = DIAL_MAX_TPS,
  accent?: (s: string) => string
): string[] {
  const value = typeof tps === 'number' && Number.isFinite(tps) ? Math.max(0, tps) : null;
  const ratio = value === null ? 0 : Math.min(1, value / maxScale);
  const cx = DIAL_COLS - 0.5;
  const cy = DIAL_ROWS * 4 - 1;

  const track: number[][] = Array.from({ length: DIAL_ROWS }, () => Array(DIAL_COLS).fill(0));
  const fill: number[][] = Array.from({ length: DIAL_ROWS }, () => Array(DIAL_COLS).fill(0));
  for (let y = 0; y < DIAL_ROWS * 4; y++) {
    for (let x = 0; x < DIAL_COLS * 2; x++) {
      const dx = x - cx;
      const dy = cy - y;
      const dist = Math.hypot(dx, dy);
      if (dist < DIAL_INNER || dist > DIAL_OUTER) continue;
      // 0 at the left end of the arc, 1 at the right end.
      const position = Math.atan2(dy, -dx) / Math.PI;
      const bit = BRAILLE_BITS[y % 4][x % 2];
      const row = y >> 2;
      const col = x >> 1;
      track[row][col] |= bit;
      if (ratio > 0 && position <= ratio) fill[row][col] |= bit;
    }
  }

  const number = value === null ? '-' : value >= 100 ? value.toFixed(0) : value.toFixed(1);
  const big = renderBigNumber(number);
  const bigWidth = displayWidth(big[0]);
  const bigLeft = Math.floor((DIAL_COLS - bigWidth) / 2);
  const bigTop = DIAL_ROWS - 4;
  const paintFill = (text: string) => (accent ? accent(text) : colorByTps(value ?? 0, text));
  const paintValue = (text: string) => (value === null || value === 0 ? c.gray(text) : paintFill(c.bold(text)));

  const lines: string[] = [];
  for (let row = 0; row < DIAL_ROWS; row++) {
    let line = '';
    for (let col = 0; col < DIAL_COLS; col++) {
      const bigRow = row - bigTop;
      if (bigRow >= 0 && bigRow < 3 && col >= bigLeft && col < bigLeft + bigWidth) {
        const ch = [...big[bigRow]][col - bigLeft];
        line += ch === ' ' ? ' ' : paintValue(ch);
        continue;
      }
      const bits = track[row][col];
      if (bits === 0) {
        line += ' ';
      } else if (fill[row][col] !== 0) {
        line += paintFill(String.fromCodePoint(0x2800 + bits));
      } else {
        line += c.gray(String.fromCodePoint(0x2800 + bits));
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface LiveDashboardState {
  /** Catalog id of the target; selects its brand colour. */
  targetId?: string;
  targetName: string;
  model: string;
  mode: BenchmarkMode;
  phases: PhaseId[];
  currentPhase?: PhaseId;
  phaseIndex: number;
  phaseTotal: number;
  phaseLabel: string;
  /** Set while `--runs N` is repeating the download. */
  repeat?: { run: number; of: number };
  tick?: GaugeTick;
  tpsHistory: number[];
  completedPhases: Partial<Record<PhaseId, PhaseResult>>;
  skippedPhases: Partial<Record<PhaseId, string>>;
  frameCounter: number;
}

function pingValue(state: LiveDashboardState): string {
  const ping = state.completedPhases.ping;
  const download = state.completedPhases.download;
  if (download?.isBuffered) return 'n/a (buffered)';
  if (ping) return ping.ttftMs === null ? 'n/a' : formatMs(ping.ttftMs);
  if (download) return download.ttftMs === null ? 'n/a' : formatMs(download.ttftMs);
  if (typeof state.tick?.ttftMs === 'number') return formatMs(state.tick.ttftMs);
  return '…';
}

function statusText(state: LiveDashboardState): string {
  const tick = state.tick;
  const phase = state.currentPhase;
  const done = phase ? state.completedPhases[phase] : undefined;
  if (done || !tick) return 'starting…';
  const seconds = `${(tick.elapsedMs / 1000).toFixed(0)}s`;
  if (tick.stage === 'streaming') {
    if (phase === 'download') return `measuring speed… ${seconds}`;
    return `answering… ${seconds}`;
  }
  if (tick.stage === 'booting') return `starting the CLI… ${seconds}`;
  if (tick.stage === 'thinking') return `model is thinking… ${seconds}`;
  if (tick.elapsedMs >= 20_000) return `still waiting for the first token… ${seconds}`;
  return `waiting for the first token… ${seconds}`;
}

const STEP_NAMES: Record<PhaseId, string> = {
  ping: 'Ping',
  download: 'Speed',
  upload: 'Large prompt',
  tool_loop: 'Tool use',
};

function stepsLine(state: LiveDashboardState): string {
  if (state.phases.length <= 1) return '';
  return state.phases
    .map((phase) => {
      const name = STEP_NAMES[phase];
      if (state.completedPhases[phase]) return c.green(`✓ ${name}`);
      if (state.skippedPhases[phase]) return c.yellow(`✗ ${name}`);
      if (state.currentPhase === phase) return c.bold(c.white(`● ${name}`));
      return c.gray(`○ ${name}`);
    })
    .join(c.gray('   '));
}

/**
 * One frame of the live speedometer: exactly FRAME_HEIGHT lines, none wider than `boxWidth`.
 * It shows one dial and three numbers; everything else waits for the result card.
 */
export function renderDashboardFrame(state: LiveDashboardState, boxWidth = MAX_FRAME_WIDTH): string {
  const width = Math.max(MIN_FRAME_COLUMNS - 1, Math.min(MAX_FRAME_WIDTH, Math.floor(boxWidth)));
  const center = (content: string) => {
    const clipped = truncateAnsi(content, width);
    return ' '.repeat(Math.max(0, Math.floor((width - displayWidth(clipped)) / 2))) + clipped;
  };

  const model = sanitizeInline(state.model);
  const name = sanitizeInline(state.targetName);
  const modelRoom = Math.max(6, width - displayWidth(name) - 3);
  const repeat = state.repeat && state.repeat.of > 1 ? c.dim(`  run ${state.repeat.run}/${state.repeat.of}`) : '';
  const accent = brandPaint(state.targetId);
  const title = `${c.bold((accent ?? c.white)(name))} ${c.gray('·')} ${c.gray(truncateAnsi(model, modelRoom))}${repeat}`;

  const download = state.completedPhases.download;
  const live = state.currentPhase === 'download' && !download;
  let dialTps: number | null = 0;
  if (download) dialTps = download.decodeTps ?? download.e2eTps;
  else if (live) dialTps = state.tick?.currentTps ?? 0;

  const dial = renderSpeedometer(dialTps, DIAL_MAX_TPS, accent);
  const scaleGap = DIAL_COLS - 1 - 12 - 4;
  const scale = `${c.gray('0')}${' '.repeat(Math.ceil(scaleGap / 2))}${c.dim('tokens / sec')}${' '.repeat(Math.floor(scaleGap / 2))}${c.gray(`${DIAL_MAX_TPS}+`)}`;

  const peak = download ? download.peakTps : live ? (state.tick?.peakTps ?? 0) : 0;
  const tokens = download ? download.outputTokens : live ? (state.tick?.tokensGenerated ?? 0) : 0;
  const stat = (label: string, value: string) => `${c.dim(label)} ${c.white(value)}`;
  const stats = [
    stat('Ping', pingValue(state)),
    stat('Peak', peak ? formatTps(peak).replace(' tok/s', '') : '—'),
    stat('Tokens', tokens > 0 ? String(tokens) : '—'),
  ].join(c.gray(width >= 50 ? '     ' : '  '));

  const spinner = (accent ?? c.brightCyan)(SPINNER_FRAMES[state.frameCounter % SPINNER_FRAMES.length]);
  const status = `${spinner} ${c.gray(statusText(state))}`;

  return [
    '',
    center(title),
    '',
    ...dial.map(center),
    center(scale),
    '',
    center(stats),
    '',
    center(stepsLine(state)),
    center(status),
  ].join('\n');
}
