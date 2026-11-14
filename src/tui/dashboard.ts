import {
  fitNameAndModel,
  formatGrade,
  formatMs,
  formatTps,
  formatTtft,
  gradePaint,
  renderResultCard,
  resultTags,
} from '../core/card.js';
import { isInterruptedError, isPhaseTimeoutError, isTargetFailedError } from '../core/errors.js';
import { compareWithHistory, loadHistory } from '../core/history.js';
import { compareResultsByRank } from '../core/metrics.js';
import type {
  FailureKind,
  HistoricalDelta,
  PhaseId,
  PhaseResult,
  RunErrorKind,
  SpeedtestEvent,
  SpeedtestResult,
  TargetInfo,
} from '../types.js';
import {
  c,
  colorByTps,
  displayWidth,
  padLeftVisible,
  padRightVisible,
  sanitizeInline,
  truncateAnsi,
  useColor,
  wrapText,
} from './ansi.js';
import {
  type LiveDashboardState,
  MAX_FRAME_WIDTH,
  MIN_FRAME_COLUMNS,
  MIN_FRAME_ROWS,
  renderDashboardFrame,
} from './gauge.js';
import { eraseLinesAbove, hideCursor, holdRawInput, maxLineWidth, out, releaseRawInput, showCursor, termSize } from './io.js';

export type OutputMode = 'tui' | 'plain' | 'json' | 'jsonl' | 'silent';

export interface TargetFailure {
  targetId: string;
  targetName: string;
  error: string;
  kind: RunErrorKind;
  failureKind?: FailureKind;
}

export function describeRunError(err: unknown): { message: string; kind: RunErrorKind; failureKind?: FailureKind } {
  const raw = err instanceof Error ? err.message : String(err);
  const message = sanitizeInline(raw.split(/\r?\n/).find((l) => l.trim() !== '') ?? raw).trim() || 'unknown error';
  if (isInterruptedError(err)) return { message, kind: 'interrupted' };
  if (isPhaseTimeoutError(err)) return { message, kind: 'timeout' };
  return { message, kind: 'failed', failureKind: isTargetFailedError(err) ? err.kind : undefined };
}

export function renderRichResultCard(
  result: SpeedtestResult,
  delta?: HistoricalDelta,
  width = maxLineWidth()
): string {
  return renderResultCard(result, delta, { width, color: useColor() });
}

/** One-line result used under each target of an `all` / `compare` run. */
export function renderCompactResult(result: SpeedtestResult, width = maxLineWidth()): string {
  const s = result.summary;
  const tags = resultTags(result);
  const head = `  ${c.brightGreen('✓')} ${c.bold(colorByTps(s.rankTps, formatTps(s.rankTps)))}`;
  const facts = c.dim(`· TTFT ${formatTtft(result)} · ${formatGrade(result)}`);
  const tagText = tags.length > 0 ? ` ${c.yellow(`[${tags.join(', ')}]`)}` : '';
  return truncateAnsi(`${head} ${facts}${tagText} ${c.dim(`· ${sanitizeInline(result.model)}`)}`, width);
}

function phaseDetail(phase: PhaseId, m: PhaseResult): string {
  if (phase === 'ping') return `TTFT ${m.ttftMs === null ? 'n/a' : formatMs(m.ttftMs)}`;
  if (phase === 'download') {
    if (m.decodeTps !== null && m.streaming) {
      return `${formatTps(m.decodeTps)} decode · peak ${formatTps(m.peakTps)} · E2E ${formatTps(m.e2eTps)} · TTFT ${formatMs(m.ttftMs)}`;
    }
    return `${formatTps(m.e2eTps)} end-to-end (buffered: no TTFT or decode rate)`;
  }
  if (phase === 'upload') {
    const bits = [`TTFT ${m.ttftMs === null ? 'n/a' : formatMs(m.ttftMs)}`];
    if (typeof m.uploadOverheadMs === 'number') bits.push(`${m.uploadOverheadMs >= 0 ? '+' : '−'}${formatMs(Math.abs(m.uploadOverheadMs))} vs ping`);
    if (typeof m.prefillTps === 'number') bits.push(`prefill ${formatTps(m.prefillTps)}`);
    return `large prompt (${m.promptTokens} tok): ${bits.join(', ')}`;
  }
  return `tool loop ${formatMs(m.durationMs)}${m.verified ? ' [verified]' : ''}`;
}

export interface ConsumeOptions {
  mode: OutputMode;
  noHistory?: boolean;
  /** Inside `all` / `compare`: no per-target header or full card, just a one-line result. */
  compact?: boolean;
  /** Called when Ctrl-C is typed while the live gauge holds the terminal in raw mode. */
  onInterruptKey?: () => void;
}

async function historyDelta(result: SpeedtestResult, noHistory?: boolean): Promise<HistoricalDelta | undefined> {
  if (noHistory) return undefined;
  try {
    return compareWithHistory(result, await loadHistory());
  } catch {
    // A history problem must never fail a finished run.
    return undefined;
  }
}

function liveGaugeFits(): boolean {
  const size = termSize();
  return size.isTTY && size.columns >= MIN_FRAME_COLUMNS && size.rows >= MIN_FRAME_ROWS;
}

/** Line-by-line progress for pipes, logs and terminals too small for the gauge. */
function createPlainReporter(compact: boolean) {
  const write = (text: string) => {
    const size = termSize();
    out(`${size.isTTY ? truncateAnsi(text, maxLineWidth(size)) : text}\n`);
  };
  return {
    onEvent(ev: SpeedtestEvent): void {
      if (ev.type === 'run:start') {
        if (compact) return;
        const model = ev.model ? ` (${sanitizeInline(ev.model)})` : '';
        const runs = ev.runs > 1 ? `, ${ev.runs} runs` : '';
        write(`Speedtest.ai — ${sanitizeInline(ev.targetName)}${model} [${ev.mode}${runs}]`);
      } else if (ev.type === 'repeat:start') {
        write(`  Run ${ev.run}/${ev.of}`);
      } else if (ev.type === 'phase:start') {
        write(`  [${ev.index}/${ev.total}] ${ev.label}...`);
      } else if (ev.type === 'phase:complete') {
        write(`      -> ${phaseDetail(ev.phase, ev.metrics)}`);
      } else if (ev.type === 'phase:skip') {
        write(`      -> failed (${sanitizeInline(ev.reason)})`);
      }
    },
  };
}

export async function consumeSpeedtestEvents(
  events: AsyncGenerator<SpeedtestEvent, SpeedtestResult, unknown>,
  options: ConsumeOptions
): Promise<SpeedtestResult> {
  const compact = Boolean(options.compact);

  if (options.mode === 'silent' || options.mode === 'json') {
    let finalResult: SpeedtestResult | undefined;
    for await (const ev of events) {
      if (ev.type === 'run:complete') finalResult = ev.result;
    }
    if (!finalResult) throw new Error('Speedtest completed without result.');
    if (options.mode === 'json') out(JSON.stringify(finalResult, null, 2) + '\n');
    return finalResult;
  }

  if (options.mode === 'jsonl') {
    let finalResult: SpeedtestResult | undefined;
    let sawError = false;
    try {
      for await (const ev of events) {
        out(JSON.stringify(ev) + '\n');
        if (ev.type === 'run:error') sawError = true;
        if (ev.type === 'run:complete') finalResult = ev.result;
      }
    } catch (err) {
      // Consumers rely on run:error; make sure every failure produces one.
      if (!sawError) {
        const described = describeRunError(err);
        out(
          JSON.stringify({
            type: 'run:error',
            error: described.message,
            kind: described.kind,
            failureKind: described.failureKind,
          }) + '\n'
        );
      }
      throw err;
    }
    if (!finalResult) throw new Error('Speedtest completed without result.');
    return finalResult;
  }

  const finish = async (result: SpeedtestResult, gap: string): Promise<SpeedtestResult> => {
    if (compact) {
      out(renderCompactResult(result) + '\n');
    } else {
      const delta = await historyDelta(result, options.noHistory);
      out(`${gap}${renderRichResultCard(result, delta)}\n`);
    }
    return result;
  };

  const plain = createPlainReporter(compact);

  if (options.mode === 'plain' || !liveGaugeFits()) {
    let finalResult: SpeedtestResult | undefined;
    for await (const ev of events) {
      plain.onEvent(ev);
      if (ev.type === 'run:complete') finalResult = ev.result;
    }
    if (!finalResult) throw new Error('Speedtest completed without result.');
    return finish(finalResult, '\n');
  }

  // Live gauge.
  let state: LiveDashboardState | undefined;
  let drawnLines = 0;
  let drawnWidth = 0;
  let degraded = false;
  let finalResult: SpeedtestResult | undefined;

  const frameWidth = () => Math.min(MAX_FRAME_WIDTH, termSize().columns - 1);

  const clearFrame = (reflowColumns?: number) => {
    if (drawnLines === 0) return;
    // After the terminal got narrower, each old line may have been re-wrapped onto several rows.
    const rowsPerLine = reflowColumns && drawnWidth > reflowColumns ? Math.ceil(drawnWidth / reflowColumns) : 1;
    out(eraseLinesAbove(drawnLines * rowsPerLine));
    drawnLines = 0;
  };

  const drawFrame = () => {
    if (!state || degraded) return;
    const width = frameWidth();
    const lines = renderDashboardFrame(state, width).split('\n');
    const moveUp = drawnLines > 0 ? `\x1b[${drawnLines}A\r` : '';
    out(`\x1b[?2026h${moveUp}${lines.map((l) => `${l}\x1b[K`).join('\n')}\n\x1b[J\x1b[?2026l`);
    drawnLines = lines.length;
    drawnWidth = width;
  };

  const onResize = () => {
    if (degraded) return;
    const size = termSize();
    clearFrame(size.columns);
    if (size.columns < MIN_FRAME_COLUMNS || size.rows < MIN_FRAME_ROWS) {
      degraded = true;
      showCursor();
      if (state?.currentPhase) {
        plain.onEvent({
          type: 'phase:start',
          phase: state.currentPhase,
          index: state.phaseIndex,
          total: state.phaseTotal,
          label: state.phaseLabel,
        });
      }
      return;
    }
    drawFrame();
  };

  process.stdout.on('resize', onResize);
  if (options.onInterruptKey) holdRawInput(options.onInterruptKey);
  hideCursor();

  try {
    for await (const ev of events) {
      if (ev.type === 'run:complete') finalResult = ev.result;
      if (degraded) {
        plain.onEvent(ev);
        continue;
      }
      if (ev.type === 'run:start') {
        state = {
          targetName: ev.targetName,
          model: ev.model || 'configured model',
          mode: ev.mode,
          phases: ev.phases,
          phaseIndex: 0,
          phaseTotal: ev.phases.length,
          phaseLabel: 'Starting…',
          tpsHistory: [],
          completedPhases: {},
          skippedPhases: {},
          frameCounter: 0,
        };
        drawFrame();
      } else if (!state) {
        continue;
      } else if (ev.type === 'repeat:start') {
        state.repeat = { run: ev.run, of: ev.of };
        if (ev.run > 1) {
          // The repeat measures the download again; the first figure must not look final.
          delete state.completedPhases.download;
          state.tpsHistory = [];
        }
        drawFrame();
      } else if (ev.type === 'phase:start') {
        state.currentPhase = ev.phase;
        state.phaseIndex = ev.index;
        state.phaseTotal = ev.total;
        state.phaseLabel = ev.label;
        state.tick = undefined;
        state.frameCounter += 1;
        drawFrame();
      } else if (ev.type === 'gauge:tick') {
        state.tick = ev.tick;
        state.frameCounter += 1;
        if (ev.tick.model && ev.tick.model !== 'default') state.model = ev.tick.model;
        if (ev.tick.phase === 'download' && ev.tick.stage === 'streaming') {
          state.tpsHistory.push(ev.tick.currentTps);
          if (state.tpsHistory.length > 60) state.tpsHistory.shift();
        }
        drawFrame();
      } else if (ev.type === 'phase:complete') {
        state.completedPhases[ev.phase] = ev.metrics;
        if (ev.metrics.model) state.model = ev.metrics.model;
        drawFrame();
      } else if (ev.type === 'phase:skip') {
        state.skippedPhases[ev.phase] = ev.reason;
        drawFrame();
      }
    }
  } finally {
    process.stdout.off('resize', onResize);
    clearFrame();
    releaseRawInput();
    showCursor();
  }

  if (!finalResult) throw new Error('Speedtest completed without result.');
  return finish(finalResult, '');
}

interface StatusBadge {
  symbol: string;
  word: string;
  paint: (s: string) => string;
}

export function targetIsRunnable(t: TargetInfo): boolean {
  return t.available && t.runnable !== false && t.authState !== 'logged_out';
}

function statusOf(t: TargetInfo): StatusBadge {
  if (!t.available) return { symbol: '○', word: 'MISSING', paint: c.gray };
  if (t.runnable === false) return { symbol: '◌', word: 'UNSUPPORTED', paint: c.yellow };
  if (t.authState === 'logged_out') return { symbol: '●', word: 'LOGGED OUT', paint: c.yellow };
  return { symbol: '●', word: 'READY', paint: c.brightGreen };
}

export function renderDetectTable(targets: TargetInfo[], width = maxLineWidth()): string {
  const lines: string[] = [];
  const found = targets.filter((t) => t.available);
  const missing = targets.filter((t) => !t.available);

  for (const text of wrapText('Detected AI agent CLIs, local runtimes and API providers', width)) {
    lines.push(c.bold(text));
  }
  lines.push('');

  const idWidth = Math.min(14, Math.max(6, ...found.map((t) => displayWidth(t.id)))) + 1;
  const nameWidth = Math.min(22, Math.max(8, ...found.map((t) => displayWidth(sanitizeInline(t.name))))) + 1;
  const showName = width >= 72;
  const showWord = width >= 50;

  for (const t of found) {
    const badge = statusOf(t);
    const cols: string[] = [`  ${badge.paint(showWord ? `${badge.symbol} ${badge.word.padEnd(11)}` : badge.symbol)}`];
    cols.push(c.bold(padRightVisible(truncateAnsi(t.id, idWidth - 1), idWidth)));
    if (showName) cols.push(padRightVisible(truncateAnsi(sanitizeInline(t.name), nameWidth - 1), nameWidth));
    const prefix = cols.join(' ');
    const notes: string[] = [];
    if (t.tier === 'experimental') notes.push('experimental');
    if (!showWord && badge.word !== 'READY') notes.push(badge.word.toLowerCase());
    if (t.reason) notes.push(sanitizeInline(t.reason));
    const room = width - displayWidth(prefix) - 1;
    lines.push(room >= 4 ? `${prefix} ${c.dim(truncateAnsi(notes.join(' · '), room))}` : prefix);
  }
  if (found.length === 0) lines.push(c.dim('  (nothing found)'));

  const groups: Array<[string, TargetInfo[]]> = [
    ['Agent CLIs not found', missing.filter((t) => t.category === 'harness')],
    ['Local runtimes not running', missing.filter((t) => t.category === 'local')],
    ['API keys not set', missing.filter((t) => t.category === 'provider')],
  ];
  for (const [label, group] of groups) {
    if (group.length === 0) continue;
    lines.push('');
    const text = `${label} (${group.length}): ${group.map((t) => t.id).join(', ')}`;
    for (const wrapped of wrapText(text, Math.max(10, width - 2))) lines.push(c.gray(`  ${wrapped}`));
  }
  return lines.join('\n');
}

interface TableColumn {
  header: string;
  values: string[];
  align?: 'left' | 'right';
  paint?: (text: string, row: number) => string;
  /** The one column that absorbs the remaining width; its values are cut with an ellipsis. */
  flex?: { min: number; max: number };
}

/**
 * Lays out a header row and data rows with two spaces between columns. Fixed columns take the
 * width of their widest value; the flex column gets what is left, minus `reserve` cells kept free
 * at the end of each line.
 */
function layoutTable(columns: TableColumn[], width: number, reserve = 0): { header: string; rows: string[]; used: number } {
  const gap = 2;
  const natural = columns.map((col) => Math.max(displayWidth(col.header), ...col.values.map((v) => displayWidth(v))));
  const fixedTotal = columns.reduce((acc, col, i) => acc + (col.flex ? 0 : natural[i]), 0) + gap * (columns.length - 1);
  const widths = columns.map((col, i) => {
    if (!col.flex) return natural[i];
    const room = width - fixedTotal - reserve;
    return Math.max(col.flex.min, Math.min(col.flex.max, natural[i], room));
  });
  const cell = (col: TableColumn, i: number, text: string) => {
    const cut = truncateAnsi(text, widths[i]);
    return col.align === 'right' ? padLeftVisible(cut, widths[i]) : padRightVisible(cut, widths[i]);
  };
  const rowCount = Math.max(0, ...columns.map((col) => col.values.length));
  const rows: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    rows.push(columns.map((col, i) => (col.paint ?? ((t: string) => t))(cell(col, i, col.values[r] ?? ''), r)).join(' '.repeat(gap)));
  }
  return {
    header: columns.map((col, i) => cell(col, i, col.header)).join(' '.repeat(gap)),
    rows,
    used: widths.reduce((a, b) => a + b, 0) + gap * (columns.length - 1),
  };
}

export interface LeaderboardOptions {
  width?: number;
  failures?: TargetFailure[];
  /** Targets that were queued but never started because the run was interrupted. */
  notRun?: string[];
  interrupted?: boolean;
  title?: string;
}

function labelOf(r: SpeedtestResult): string {
  return `${r.targetId}:${sanitizeInline(r.model)}`;
}

export function renderCompareTable(results: SpeedtestResult[], options: LeaderboardOptions = {}): string {
  const width = Math.max(24, Math.floor(options.width ?? maxLineWidth()));
  const sorted = [...results].sort(compareResultsByRank);
  const failures = options.failures ?? [];
  const lines: string[] = [];

  const heading = options.interrupted
    ? 'Speedtest.ai partial leaderboard (interrupted)'
    : (options.title ?? 'Speedtest.ai leaderboard (fastest first)');
  if (sorted.length > 0) {
    lines.push(c.bold(truncateAnsi(heading, width)));
    lines.push('');
  }

  const rows = sorted.map((r, idx) => ({
    result: r,
    rank: `#${idx + 1}`,
    label: labelOf(r),
    tps: formatTps(r.summary.rankTps),
    ttft: typeof r.summary.ttftMs === 'number' ? formatMs(r.summary.ttftMs) : 'n/a',
    e2e: formatTps(r.summary.downloadE2eTps).replace(/ tok\/s$/, ''),
    grade: formatGrade(r),
    tags: resultTags(r).join(' · '),
  }));
  const stacked = width < 64;

  if (stacked) {
    for (const row of rows) {
      const s = row.result.summary;
      lines.push(truncateAnsi(`${c.bold(row.rank.padEnd(3))} ${c.white(row.label)}`, width));
      lines.push(
        truncateAnsi(
          `    ${c.bold(colorByTps(s.rankTps, row.tps))} ${c.dim(`· TTFT ${row.ttft} ·`)} ${gradePaint(c, s.grade)(row.grade)}`,
          width
        )
      );
      for (const text of wrapText(row.tags, width - 4)) lines.push(`    ${c.yellow(text)}`);
    }
  } else if (rows.length > 0) {
    const maxTps = Math.max(20, ...sorted.map((r) => r.summary.rankTps));
    const barWidth = width >= 100 ? 16 : 0;
    const summaryOf = (row: number) => rows[row].result.summary;
    const columns: TableColumn[] = [
      { header: '#', values: rows.map((r) => r.rank), paint: (t) => c.bold(t) },
      { header: 'TARGET', values: rows.map((r) => r.label), paint: (t) => c.white(t), flex: { min: 12, max: 40 } },
      {
        header: 'TOK/S',
        values: rows.map((r) => r.tps),
        align: 'right',
        paint: (t, row) => c.bold(colorByTps(summaryOf(row).rankTps, t)),
      },
      { header: 'TTFT', values: rows.map((r) => r.ttft) },
      { header: 'E2E', values: rows.map((r) => r.e2e), align: 'right' },
    ];
    if (barWidth > 0) {
      columns.push({
        header: '',
        values: rows.map((r) => {
          const filled = Math.max(1, Math.round((r.result.summary.rankTps / maxTps) * barWidth));
          return '█'.repeat(filled) + ' '.repeat(barWidth - filled);
        }),
        paint: (t, row) => colorByTps(summaryOf(row).rankTps, t),
      });
    }
    columns.push({
      header: 'GRADE',
      values: rows.map((r) => r.grade),
      paint: (t, row) => gradePaint(c, summaryOf(row).grade)(t),
    });

    // Keep room for the shortest tag text next to the row; longer ones go on a continuation line.
    const tagWidths = rows.map((r) => displayWidth(r.tags)).filter((w) => w > 0);
    const reserve = tagWidths.length > 0 ? Math.min(...tagWidths) + 2 : 0;
    const table = layoutTable(columns, width, reserve);
    const tagRoom = width - table.used - 2;

    lines.push(c.dim(table.header.trimEnd()));
    rows.forEach((row, i) => {
      if (row.tags === '') {
        lines.push(table.rows[i].trimEnd());
      } else if (displayWidth(row.tags) <= tagRoom) {
        lines.push(`${table.rows[i]}  ${c.yellow(row.tags)}`);
      } else {
        lines.push(table.rows[i].trimEnd());
        for (const text of wrapText(row.tags, width - 7)) lines.push(`     ${c.yellow(`↳ ${text}`)}`);
      }
    });
  }

  if (sorted.length > 0) {
    lines.push('');
    const notes: string[] = [
      'tok/s = normalized tokens (one local estimator for every target), decode rate after the first token. TTFT = wait for the first token, from process start. E2E = tok/s including that wait.',
    ];
    if (sorted.some((r) => r.summary.rankMetric === 'e2e')) {
      notes.push('(E2E) = no real stream (buffered): ranked after streaming targets, on end-to-end tok/s.');
    }
    if (sorted.some((r) => resultTags(r).includes('slow start'))) {
      notes.push('slow start = waited 30s or more for the first token; judge it by E2E, not TOK/S.');
    }
    if (sorted.some((r) => r.runs === 1)) {
      notes.push('Single sample per target; rerun with --runs 3 for medians and a range.');
    }
    if (sorted.some((r) => r.isolation === 'lean')) {
      notes.push('lean = your login and model, without MCP servers, hooks, plugins or project context (--as-configured keeps them).');
    }
    for (const note of notes) {
      for (const text of wrapText(note, width)) lines.push(c.dim(text));
    }
  }

  if (failures.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      c.bold(c.yellow(truncateAnsi(sorted.length > 0 ? 'Failed / skipped:' : 'No target completed a benchmark:', width)))
    );
    for (const f of failures) {
      const head = `${f.targetId} (${sanitizeInline(f.targetName)}): `;
      const kind =
        f.kind === 'timeout'
          ? ''
          : f.failureKind && f.failureKind !== 'other'
            ? `[${f.failureKind.replace('_', ' ')}] `
            : '';
      const wrapped = wrapText(`${head}${kind}${sanitizeInline(f.error)}`, Math.max(10, width - 4));
      const shown = wrapped.slice(0, 4);
      if (wrapped.length > shown.length) shown[shown.length - 1] = truncateAnsi(`${shown[shown.length - 1]} …`, width - 4);
      shown.forEach((text, i) => lines.push(i === 0 ? `  ${c.yellow('⚠')} ${text}` : `    ${c.gray(text)}`));
    }
  }

  if (options.notRun && options.notRun.length > 0) {
    if (lines.length > 0) lines.push('');
    for (const text of wrapText(`Not run (interrupted): ${options.notRun.join(', ')}`, width)) lines.push(c.gray(text));
  }

  return lines.join('\n');
}

export function renderHistoryTable(
  history: SpeedtestResult[],
  limit = 15,
  options: { width?: number; legacyCount?: number } = {}
): string {
  const width = Math.max(24, Math.floor(options.width ?? maxLineWidth()));
  const legacy = options.legacyCount ?? 0;
  const legacyNote =
    legacy > 0
      ? c.dim(truncateAnsi(`${legacy} older-format ${legacy === 1 ? 'entry is' : 'entries are'} not shown.`, width))
      : '';

  if (history.length === 0) {
    const empty = wrapText('No speedtest runs recorded yet. Try "speedtest-ai demo" or "speedtest-ai all".', width)
      .map((l) => c.dim(l))
      .join('\n');
    return legacyNote ? `${empty}\n${legacyNote}` : empty;
  }

  const recent = history.slice(-limit).reverse();
  const lines: string[] = [
    c.bold(truncateAnsi(`Recent speedtest runs (${recent.length} of ${history.length})`, width)),
    '',
  ];
  const ttftOf = (r: SpeedtestResult) => (typeof r.summary.ttftMs === 'number' ? formatMs(r.summary.ttftMs) : 'n/a');
  const when = (r: SpeedtestResult) => r.timestamp.slice(0, 16).replace('T', ' ');

  if (width < 72) {
    for (const r of recent) {
      const s = r.summary;
      lines.push(truncateAnsi(`${c.gray(when(r))}  ${c.white(labelOf(r))}`, width));
      lines.push(
        truncateAnsi(
          `    ${colorByTps(s.rankTps, formatTps(s.rankTps))} ${c.dim(`· TTFT ${ttftOf(r)} · ${r.mode} ·`)} ${gradePaint(c, s.grade)(formatGrade(r))}`,
          width
        )
      );
    }
  } else {
    const table = layoutTable(
      [
        { header: 'WHEN (UTC)', values: recent.map(when), paint: (t) => c.gray(t) },
        { header: 'TARGET', values: recent.map(labelOf), paint: (t) => c.white(t), flex: { min: 10, max: 44 } },
        {
          header: 'TOK/S',
          values: recent.map((r) => formatTps(r.summary.rankTps)),
          align: 'right',
          paint: (t, row) => colorByTps(recent[row].summary.rankTps, t),
        },
        { header: 'TTFT', values: recent.map(ttftOf) },
        { header: 'MODE', values: recent.map((r) => r.mode), paint: (t) => c.dim(t) },
        {
          header: 'GRADE',
          values: recent.map(formatGrade),
          paint: (t, row) => gradePaint(c, recent[row].summary.grade)(t),
        },
      ],
      width
    );
    lines.push(c.dim(table.header.trimEnd()));
    for (const row of table.rows) lines.push(row.trimEnd());
  }
  if (legacyNote) lines.push('', legacyNote);
  return lines.join('\n');
}

export { fitNameAndModel };
