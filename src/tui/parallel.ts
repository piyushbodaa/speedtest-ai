import { formatMs, formatTps } from '../core/card.js';
import type { GaugeTick, SpeedtestEvent, SpeedtestResult } from '../types.js';
import { c, displayWidth, sanitizeInline, truncateAnsi } from './ansi.js';
import { brandPaint, kmAccent, PRODUCT_TAG } from './brand.js';
import { eraseLinesAbove, hideCursor, holdRawInput, maxLineWidth, out, releaseRawInput, showCursor, termSize } from './io.js';

/** One target of a parallel run: its identity and the event stream of its speed test. */
export interface ParallelEntry {
  id: string;
  name: string;
  events: AsyncGenerator<SpeedtestEvent, SpeedtestResult, unknown>;
}

export interface ParallelOutcome {
  id: string;
  result?: SpeedtestResult;
  error?: unknown;
}

export interface ParallelRow {
  id: string;
  name: string;
  tick?: GaugeTick;
  result?: SpeedtestResult;
  failed?: string;
}

const BAR_CELLS = 20;
const BAR_MAX_TPS = 200;

function rowStatus(row: ParallelRow): string {
  const accent = brandPaint(row.id) ?? kmAccent;
  if (row.failed !== undefined) return `${c.yellow('✗')} ${c.gray(sanitizeInline(row.failed))}`;
  if (row.result) {
    const s = row.result.summary;
    const ttft = typeof s.ttftMs === 'number' ? ` · first token ${formatMs(s.ttftMs)}` : '';
    return `${c.green('✓')} ${c.bold(formatTps(s.rankTps))}${c.gray(ttft)}`;
  }
  const tick = row.tick;
  if (!tick) return c.gray('starting…');
  const seconds = `${(tick.elapsedMs / 1000).toFixed(0)}s`;
  if (tick.stage !== 'streaming' || tick.tokensGenerated === 0) {
    return c.gray(`${tick.stage === 'booting' ? 'starting' : 'waiting for first token'}… ${seconds}`);
  }
  const filled = Math.max(1, Math.min(BAR_CELLS, Math.round((tick.currentTps / BAR_MAX_TPS) * BAR_CELLS)));
  return `${accent('█'.repeat(filled))}${c.gray('░'.repeat(BAR_CELLS - filled))} ${c.bold(formatTps(tick.currentTps))}`;
}

/** The live view of a parallel run: one line per agent, all moving at once. */
export function renderParallelFrame(rows: ParallelRow[], width: number): string {
  const nameWidth = Math.min(20, Math.max(...rows.map((r) => displayWidth(sanitizeInline(r.name)))));
  const running = rows.filter((r) => !r.result && r.failed === undefined).length;
  const head = `${c.dim(kmAccent(PRODUCT_TAG))} ${c.gray(`· ${rows.length} agents in parallel${running ? `, ${running} still running` : ''}`)}`;
  const lines = [truncateAnsi(head, width), ''];
  for (const row of rows) {
    const accent = brandPaint(row.id) ?? c.white;
    const name = truncateAnsi(sanitizeInline(row.name), nameWidth);
    const pad = ' '.repeat(Math.max(0, nameWidth - displayWidth(name)));
    lines.push(truncateAnsi(`  ${c.bold(accent(name))}${pad}  ${rowStatus(row)}`, width));
  }
  return lines.join('\n');
}

export interface ParallelViewOptions {
  /** 'tui' animates, 'plain' prints a line when each agent starts and finishes, 'jsonl' forwards events. */
  mode: 'tui' | 'plain' | 'jsonl' | 'silent';
  onInterruptKey?: () => void;
  describeError: (error: unknown) => string;
}

/**
 * Runs every entry's event stream at the same time. Never rejects: each target ends with a result
 * or an error of its own, so one failure does not lose the others.
 */
export async function consumeParallel(entries: ParallelEntry[], options: ParallelViewOptions): Promise<ParallelOutcome[]> {
  const rows: ParallelRow[] = entries.map((e) => ({ id: e.id, name: e.name }));
  const size = termSize();
  const animated = options.mode === 'tui' && size.isTTY && size.columns >= 40;
  const lineMode = options.mode === 'plain' || (options.mode === 'tui' && !animated);

  let drawn = 0;
  const draw = () => {
    if (!animated) return;
    const lines = renderParallelFrame(rows, maxLineWidth()).split('\n');
    const moveUp = drawn > 0 ? `\x1b[${drawn}A\r` : '';
    out(`\x1b[?2026h${moveUp}${lines.map((l) => `${l}\x1b[K`).join('\n')}\n\x1b[J\x1b[?2026l`);
    drawn = lines.length;
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  if (animated) {
    if (options.onInterruptKey) holdRawInput(options.onInterruptKey);
    hideCursor();
    draw();
    timer = setInterval(draw, 100);
  }

  const one = async (entry: ParallelEntry, row: ParallelRow): Promise<ParallelOutcome> => {
    try {
      let result: SpeedtestResult | undefined;
      for await (const ev of entry.events) {
        if (options.mode === 'jsonl') out(JSON.stringify({ ...ev, target: entry.id }) + '\n');
        if (ev.type === 'gauge:tick') row.tick = ev.tick;
        else if (ev.type === 'run:start' && lineMode) out(`  ${sanitizeInline(entry.name)}: started\n`);
        else if (ev.type === 'run:complete') result = ev.result;
      }
      if (!result) throw new Error('the run ended without a result');
      row.result = result;
      return { id: entry.id, result };
    } catch (error) {
      row.failed = options.describeError(error);
      if (lineMode) out(`  ${sanitizeInline(entry.name)}: ${row.failed}\n`);
      return { id: entry.id, error };
    }
  };

  try {
    return await Promise.all(entries.map((entry, i) => one(entry, rows[i])));
  } finally {
    if (timer) clearInterval(timer);
    if (animated) {
      // The per-agent result lines and the leaderboard replace the live frame.
      if (drawn > 0) out(eraseLinesAbove(drawn));
      releaseRawInput();
      showCursor();
    }
  }
}
