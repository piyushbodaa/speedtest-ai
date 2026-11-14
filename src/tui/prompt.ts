import type { BenchmarkMode, TargetInfo } from '../types.js';
import { c, displayWidth, padRightVisible, sanitizeInline, truncateAnsi } from './ansi.js';
import { targetIsRunnable } from './dashboard.js';
import { eraseLinesAbove, hideCursor, holdRawInput, out, releaseRawInput, showCursor, termSize } from './io.js';

export interface InteractiveSelection {
  targetId: string;
  mode: BenchmarkMode;
}

/** `interrupted` = Ctrl-C; `cancelled` = q / Esc. */
export type PickerOutcome =
  | { kind: 'selected'; selection: InteractiveSelection }
  | { kind: 'cancelled' }
  | { kind: 'interrupted' };

export interface PickerOptions {
  initialMode?: BenchmarkMode;
  /** The targets `all` would run; the ALL row is offered when there is at least one. */
  allTargets: TargetInfo[];
  signal?: AbortSignal;
}

const MODES: BenchmarkMode[] = ['quick', 'standard', 'full'];

interface PickerItem {
  id: string;
  name: string;
  detail: string;
  selectable: boolean;
  ready: boolean;
}

export function buildPickerItems(targets: TargetInfo[], allTargets: TargetInfo[]): PickerItem[] {
  const items: PickerItem[] = [];
  if (allTargets.length > 0) {
    items.push({
      id: 'all',
      name: 'ALL installed CLIs',
      detail: `${allTargets.length} ${allTargets.length === 1 ? 'target' : 'targets'}, spends real model tokens`,
      selectable: true,
      ready: true,
    });
  }
  for (const t of targets) {
    if (!t.available) continue;
    const runnable = targetIsRunnable(t);
    const notes: string[] = [];
    if (t.tier === 'experimental') notes.push('experimental');
    if (t.reason) notes.push(sanitizeInline(t.reason));
    items.push({ id: t.id, name: sanitizeInline(t.name), detail: notes.join(' · '), selectable: runnable, ready: runnable });
  }
  return items;
}

/** The menu as lines no wider than `columns - 1`, with a scrolling window that fits `rows`. */
export function renderPickerLines(
  items: PickerItem[],
  missingIds: string[],
  selectedIdx: number,
  mode: BenchmarkMode,
  size: { columns: number; rows: number }
): string[] {
  const width = Math.max(20, size.columns - 1);
  const fit = (text: string) => truncateAnsi(text, width);
  const modeText = c.bold(c.white(mode.toUpperCase()));

  const lines: string[] = [fit(c.bold(c.brightCyan('SPEEDTEST.AI — choose what to benchmark')))];
  if (width >= 62) {
    lines.push(fit(`${c.dim('  [↑/↓] choose   [Tab] mode: ')}${modeText}${c.dim('   [Enter] start   [q] quit')}`));
  } else {
    lines.push(fit(`${c.dim('  ↑/↓ choose · Tab mode: ')}${modeText}`));
    lines.push(fit(c.dim('  Enter start · q quit')));
  }
  lines.push('');

  const footer: string[] = [];
  if (missingIds.length > 0 && size.rows >= 12) {
    footer.push(fit(c.gray(`  ${missingIds.length} more not found; see "speedtest-ai detect"`)));
  }

  // One row is left for the cursor below the menu, one for a possible "more" marker.
  const room = Math.max(1, size.rows - lines.length - footer.length - 2);
  let start = 0;
  if (items.length > room) {
    start = Math.max(0, Math.min(items.length - room, selectedIdx - Math.floor(room / 2)));
  }
  const visible = items.slice(start, start + room);

  const nameWidth = Math.min(22, Math.max(...items.map((i) => displayWidth(i.name)), 4));
  const idWidth = Math.min(14, Math.max(...items.map((i) => displayWidth(i.id)), 2)) + 2;
  const showId = width >= 56;

  visible.forEach((item, offset) => {
    const active = start + offset === selectedIdx;
    const pointer = active ? c.brightCyan('❯ ') : '  ';
    const status = item.ready ? c.brightGreen('●') : c.yellow('◌');
    const nameText = padRightVisible(truncateAnsi(item.name, nameWidth), nameWidth);
    const name = !item.selectable ? c.gray(nameText) : active ? c.bold(c.white(nameText)) : nameText;
    const id = showId ? ` ${c.gray(padRightVisible(`(${item.id})`, idWidth))}` : '';
    lines.push(fit(`${pointer}${status} ${name}${id} ${c.dim(item.detail)}`));
  });

  const hiddenAbove = start;
  const hiddenBelow = items.length - (start + visible.length);
  if (hiddenAbove + hiddenBelow > 0) {
    const bits: string[] = [];
    if (hiddenAbove > 0) bits.push(`↑ ${hiddenAbove} more`);
    if (hiddenBelow > 0) bits.push(`↓ ${hiddenBelow} more`);
    lines.push(fit(c.dim(`  ${bits.join('   ')}`)));
  }
  lines.push(...footer);
  return lines;
}

export async function promptInteractiveTarget(
  targets: TargetInfo[],
  options: PickerOptions
): Promise<PickerOutcome> {
  const items = buildPickerItems(targets, options.allTargets);
  const missingIds = targets.filter((t) => !t.available).map((t) => t.id);
  const selectable = items.map((item, idx) => (item.selectable ? idx : -1)).filter((idx) => idx >= 0);
  if (selectable.length === 0) return { kind: 'cancelled' };

  let selectedIdx = selectable[0];
  let modeIdx = Math.max(0, MODES.indexOf(options.initialMode ?? 'quick'));
  let drawnLines = 0;
  let drawnWidth = 0;

  const draw = (reflowColumns?: number) => {
    const size = termSize();
    const lines = renderPickerLines(items, missingIds, selectedIdx, MODES[modeIdx], size);
    const rowsPerLine = reflowColumns && drawnWidth > reflowColumns ? Math.ceil(drawnWidth / reflowColumns) : 1;
    const moveUp = drawnLines > 0 ? `\x1b[${drawnLines * rowsPerLine}A\r` : '';
    out(`\x1b[?2026h${moveUp}${lines.map((l) => `${l}\x1b[K`).join('\n')}\n\x1b[J\x1b[?2026l`);
    drawnLines = lines.length;
    drawnWidth = Math.max(...lines.map((l) => displayWidth(l)));
  };

  const move = (step: 1 | -1) => {
    const pos = selectable.indexOf(selectedIdx);
    selectedIdx = selectable[(pos + step + selectable.length) % selectable.length];
    draw();
  };

  return new Promise<PickerOutcome>((resolve) => {
    let settled = false;
    const onResize = () => draw(termSize().columns);
    const onAbort = () => finish({ kind: 'interrupted' });

    const finish = (outcome: PickerOutcome) => {
      if (settled) return;
      settled = true;
      process.stdout.off('resize', onResize);
      options.signal?.removeEventListener('abort', onAbort);
      releaseRawInput();
      if (drawnLines > 0) out(eraseLinesAbove(drawnLines));
      showCursor();
      resolve(outcome);
    };

    const handleKey = (key: string) => {
      if (key === '\x1b' || key === 'q' || key === 'Q') return finish({ kind: 'cancelled' });
      if (key === '\x1b[A' || key === '\x1bOA' || key === 'k') return move(-1);
      if (key === '\x1b[B' || key === '\x1bOB' || key === 'j') return move(1);
      if (key === '\t') {
        modeIdx = (modeIdx + 1) % MODES.length;
        return draw();
      }
      if (key === '\r' || key === '\n') {
        return finish({ kind: 'selected', selection: { targetId: items[selectedIdx].id, mode: MODES[modeIdx] } });
      }
    };

    // Pasted or piped input can deliver several keys in one read.
    const onKey = (data: Buffer) => {
      for (const key of data.toString('utf8').match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|[\s\S]/g) ?? []) {
        if (settled) return;
        handleKey(key);
      }
    };

    if (options.signal?.aborted) return finish({ kind: 'interrupted' });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    process.stdout.on('resize', onResize);
    holdRawInput(() => finish({ kind: 'interrupted' }), onKey);
    hideCursor();
    draw();
  });
}
