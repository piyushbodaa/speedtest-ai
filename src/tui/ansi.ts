// CSI sequences (including private-mode ones such as ESC[?25l) and OSC strings.
const ANSI_SOURCE = '\\x1b\\[[0-9;:<=>?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[@-Z\\\\^_]';
const ANSI_RE = new RegExp(ANSI_SOURCE, 'g');
const ANSI_AT_RE = new RegExp(ANSI_SOURCE, 'y');
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const RESET = '\x1b[0m';

export function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

/**
 * Makes text from outside (model output, model names, error messages) safe to put on one terminal
 * line: escape sequences and control characters would otherwise move the cursor or recolour the UI.
 */
export function sanitizeInline(str: string): string {
  return stripAnsi(str)
    .replace(LONE_SURROGATE_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(/ {2,}/g, ' ');
}

/** Terminal cells occupied by one code point: 0 for combining marks, 2 for wide (CJK, emoji). */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x483 && cp <= 0x489) ||
    (cp >= 0x591 && cp <= 0x5bd) ||
    (cp >= 0x610 && cp <= 0x61a) ||
    (cp >= 0x64b && cp <= 0x65f) ||
    (cp >= 0x900 && cp <= 0x902) ||
    (cp >= 0x93c && cp <= 0x94d && cp !== 0x93d) ||
    (cp >= 0xe31 && cp <= 0xe3a && cp !== 0xe32 && cp !== 0xe33) ||
    (cp >= 0xe47 && cp <= 0xe4e) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0xfeff ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp === 0x1f004 ||
    cp === 0x1f0cf ||
    cp === 0x1f18e ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f2ff) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Terminal cells a string occupies, ignoring escape sequences and counting wide characters as 2. */
export function displayWidth(str: string): number {
  const plain = stripAnsi(str);
  let width = 0;
  for (const ch of plain) width += charWidth(ch.codePointAt(0)!);
  return width;
}

export const visibleLength = displayWidth;

export function padRightVisible(str: string, targetWidth: number): string {
  const len = displayWidth(str);
  if (len >= targetWidth) return str;
  return str + ' '.repeat(targetWidth - len);
}

export function padLeftVisible(str: string, targetWidth: number): string {
  const len = displayWidth(str);
  if (len >= targetWidth) return str;
  return ' '.repeat(targetWidth - len) + str;
}

/**
 * Cuts `str` to at most `maxWidth` terminal cells. Escape sequences are kept (they take no room),
 * so a truncated string keeps its colours; a reset is appended when any styling was seen.
 */
export function truncateAnsi(str: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(str) <= maxWidth) return str;

  const ellipsisWidth = displayWidth(ellipsis);
  const budget = maxWidth > ellipsisWidth ? maxWidth - ellipsisWidth : maxWidth;
  const tail = maxWidth > ellipsisWidth ? ellipsis : '';

  let out = '';
  let width = 0;
  let styled = false;
  let i = 0;
  while (i < str.length) {
    ANSI_AT_RE.lastIndex = i;
    const esc = ANSI_AT_RE.exec(str);
    if (esc) {
      out += esc[0];
      styled = true;
      i += esc[0].length;
      continue;
    }
    const cp = str.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (width + w > budget) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  return out + tail + (styled ? RESET : '');
}

export const truncateVisible = truncateAnsi;

/** Truncates then pads, so the result occupies exactly `width` cells. */
export function fitVisible(str: string, width: number): string {
  return padRightVisible(truncateAnsi(str, width), width);
}

/** Keeps the END of a plain string that fits in `maxWidth` cells (for a scrolling stream preview). */
export function tailToWidth(plain: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const chars = [...plain];
  let width = 0;
  let start = chars.length;
  while (start > 0) {
    const w = charWidth(chars[start - 1].codePointAt(0)!);
    if (width + w > maxWidth) break;
    width += w;
    start -= 1;
  }
  return chars.slice(start).join('');
}

/** Greedy word wrap of plain text to `width` cells; words longer than a line are hard-split. */
export function wrapText(plain: string, width: number): string[] {
  const max = Math.max(1, width);
  const lines: string[] = [];
  let current = '';
  const pushWord = (word: string) => {
    let rest = word;
    while (displayWidth(rest) > max) {
      const head = truncateAnsi(rest, max, '');
      // A single cell too narrow for a wide character would never make progress.
      if (head.length === 0) return;
      lines.push(head);
      rest = rest.slice(head.length);
    }
    current = rest;
  };
  for (const word of plain.split(/\s+/).filter(Boolean)) {
    if (current === '') {
      pushWord(word);
    } else if (displayWidth(current) + 1 + displayWidth(word) <= max) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = '';
      pushWord(word);
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

function wrap(code: string, text: string, colorEnabled = useColor()): string {
  if (!colorEnabled || text === '') return text;
  return `\x1b[${code}m${text}${RESET}`;
}

/**
 * A 24-bit foreground colour, downgraded to the 256-colour cube when the terminal does not
 * advertise truecolor.
 */
export function rgb(r: number, g: number, b: number): (s: string) => string {
  const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
  const cube = (v: number) => Math.round((v / 255) * 5);
  const code = truecolor ? `38;2;${r};${g};${b}` : `38;5;${16 + 36 * cube(r) + 6 * cube(g) + cube(b)}`;
  return (s) => wrap(code, s);
}

export interface Palette {
  bold(s: string): string;
  dim(s: string): string;
  cyan(s: string): string;
  brightCyan(s: string): string;
  green(s: string): string;
  brightGreen(s: string): string;
  yellow(s: string): string;
  brightYellow(s: string): string;
  magenta(s: string): string;
  brightMagenta(s: string): string;
  red(s: string): string;
  brightRed(s: string): string;
  white(s: string): string;
  gray(s: string): string;
}

export const c: Palette = {
  bold: (s) => wrap('1', s),
  dim: (s) => wrap('2', s),
  cyan: (s) => wrap('36', s),
  brightCyan: (s) => wrap('96', s),
  green: (s) => wrap('32', s),
  brightGreen: (s) => wrap('92', s),
  yellow: (s) => wrap('33', s),
  brightYellow: (s) => wrap('93', s),
  magenta: (s) => wrap('35', s),
  brightMagenta: (s) => wrap('95', s),
  red: (s) => wrap('31', s),
  brightRed: (s) => wrap('91', s),
  white: (s) => wrap('97', s),
  gray: (s) => wrap('90', s),
};

const identity = (s: string) => s;

export const plainPalette: Palette = {
  bold: identity,
  dim: identity,
  cyan: identity,
  brightCyan: identity,
  green: identity,
  brightGreen: identity,
  yellow: identity,
  brightYellow: identity,
  magenta: identity,
  brightMagenta: identity,
  red: identity,
  brightRed: identity,
  white: identity,
  gray: identity,
};

export function tpsColor(palette: Palette, tps: number): (s: string) => string {
  if (tps >= 140) return palette.brightMagenta;
  if (tps >= 80) return palette.brightGreen;
  if (tps >= 40) return palette.brightCyan;
  if (tps >= 20) return palette.brightYellow;
  return palette.brightRed;
}

export function colorByTps(tps: number, text: string): string {
  return tpsColor(c, tps)(text);
}
