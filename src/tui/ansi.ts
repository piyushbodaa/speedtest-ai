const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return false;
  }
  return Boolean(process.stdout.isTTY);
}

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

export function visibleLength(str: string): number {
  return [...stripAnsi(str)].length;
}

export function padRightVisible(str: string, targetWidth: number): string {
  const len = visibleLength(str);
  if (len >= targetWidth) return str;
  return str + ' '.repeat(targetWidth - len);
}

export function truncateVisible(str: string, maxWidth: number): string {
  if (visibleLength(str) <= maxWidth) return str;
  const plain = stripAnsi(str);
  const chars = [...plain];
  if (maxWidth <= 1) return chars.slice(0, maxWidth).join('');
  return chars.slice(0, maxWidth - 1).join('') + '…';
}

function wrap(code: string, text: string, colorEnabled = useColor()): string {
  if (!colorEnabled) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export const c = {
  bold: (s: string) => wrap('1', s),
  dim: (s: string) => wrap('2', s),
  cyan: (s: string) => wrap('36', s),
  brightCyan: (s: string) => wrap('96', s),
  green: (s: string) => wrap('32', s),
  brightGreen: (s: string) => wrap('92', s),
  yellow: (s: string) => wrap('33', s),
  brightYellow: (s: string) => wrap('93', s),
  magenta: (s: string) => wrap('35', s),
  brightMagenta: (s: string) => wrap('95', s),
  red: (s: string) => wrap('31', s),
  brightRed: (s: string) => wrap('91', s),
  white: (s: string) => wrap('97', s),
  gray: (s: string) => wrap('90', s),
};

export function colorByTps(tps: number, text: string): string {
  if (tps >= 140) return c.brightMagenta(text);
  if (tps >= 80) return c.brightGreen(text);
  if (tps >= 40) return c.brightCyan(text);
  if (tps >= 20) return c.brightYellow(text);
  return c.brightRed(text);
}
