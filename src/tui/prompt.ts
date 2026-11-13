import readline from 'node:readline';
import type { BenchmarkMode, TargetInfo } from '../types.js';
import { c } from './ansi.js';

export interface InteractiveSelection {
  targetId: string;
  model?: string;
  mode: BenchmarkMode;
}

const MODES: BenchmarkMode[] = ['quick', 'standard', 'full'];

export async function promptInteractiveTarget(
  targets: TargetInfo[]
): Promise<InteractiveSelection | null> {
  const ready = targets.filter((t) => t.available);
  const readyRealTargets = ready.filter((t) => t.category !== 'demo');
  const unavailable = targets.filter((t) => !t.available);
  const allOption: TargetInfo[] =
    readyRealTargets.length > 0
      ? [
          {
            id: 'all',
            name: 'ALL Ready CLIs',
            category: 'harness',
            available: true,
            supportsToolLoop: true,
            reason: `Benchmark all ${readyRealTargets.length} detected (${readyRealTargets.map((t) => t.id).join(', ')})`,
          },
        ]
      : [];
  const ordered = [...allOption, ...ready, ...unavailable];

  let selectedIdx = 0;
  let modeIdx = 0;

  const renderMenu = (prevLines: number): number => {
    const lines: string[] = [
      c.bold(c.brightCyan('SPEEDTEST.AI — Select an AI Agent or Model to Benchmark')),
      c.dim('  [↑/↓] Choose target   [Tab] Mode: ') +
        c.bold(c.white(MODES[modeIdx].toUpperCase())) +
        c.dim('   [Enter] Start   [q] Quit'),
      '',
    ];

    ordered.forEach((t, idx) => {
      const active = idx === selectedIdx;
      const pointer = active ? c.brightCyan('❯ ') : '  ';
      const status = t.available ? c.brightGreen('●') : c.gray('○');
      const name = active ? c.bold(c.white(t.name.padEnd(20))) : t.name.padEnd(20);
      const id = c.gray(`(${t.id})`.padEnd(12));
      const detail = c.dim(t.reason || '');
      lines.push(`${pointer}${status} ${name} ${id} ${detail}`);
    });

    const moveUp = prevLines > 0 ? `\x1b[${prevLines}A\r\x1b[J` : '';
    process.stdout.write(`\x1b[?2026h${moveUp}${lines.join('\n')}\n\x1b[?2026l`);
    return lines.length;
  };

  return new Promise<InteractiveSelection | null>((resolve) => {
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    process.stdout.write('\x1b[?25l');

    let prevLines = renderMenu(0);

    const cleanup = () => {
      stdin.off('keypress', onKeypress);
      if (stdin.isTTY) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
      if (prevLines > 0) {
        process.stdout.write(`\x1b[${prevLines}A\r\x1b[J`);
      }
      process.stdout.write('\x1b[?25h');
    };

    const onKeypress = (_str: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === 'q' || key.name === 'escape') {
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        selectedIdx = (selectedIdx - 1 + ordered.length) % ordered.length;
        prevLines = renderMenu(prevLines);
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        selectedIdx = (selectedIdx + 1) % ordered.length;
        prevLines = renderMenu(prevLines);
        return;
      }
      if (key.name === 'tab') {
        modeIdx = (modeIdx + 1) % MODES.length;
        prevLines = renderMenu(prevLines);
        return;
      }
      if (key.name === 'return') {
        const chosen = ordered[selectedIdx];
        cleanup();
        resolve({
          targetId: chosen.id,
          model: chosen.defaultModel,
          mode: MODES[modeIdx],
        });
      }
    };

    stdin.on('keypress', onKeypress);
  });
}
