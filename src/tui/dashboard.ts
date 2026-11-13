import { formatMs, formatTps, renderTextCard } from '../core/card.js';
import { compareWithHistory, loadHistory } from '../core/history.js';
import type {
  HistoricalDelta,
  SpeedGrade,
  SpeedtestEvent,
  SpeedtestResult,
  TargetInfo,
} from '../types.js';
import { c, colorByTps, padRightVisible, useColor } from './ansi.js';
import { type LiveDashboardState, renderDashboardFrame } from './gauge.js';

function colorGrade(grade: SpeedGrade): string {
  switch (grade) {
    case 'HYPER':
      return c.bold(c.brightMagenta(grade));
    case 'TURBO':
      return c.bold(c.brightGreen(grade));
    case 'CRUISING':
      return c.bold(c.brightCyan(grade));
    case 'STEADY':
      return c.bold(c.brightYellow(grade));
    case 'CRAWLING':
      return c.bold(c.brightRed(grade));
  }
}

export function renderRichResultCard(
  result: SpeedtestResult,
  delta?: HistoricalDelta
): string {
  if (!useColor()) {
    return renderTextCard(result, delta);
  }

  const width = 66;
  const inner = width - 4;
  const line = (content: string) => `│ ${padRightVisible(content, inner)} │`;
  const top = `┌${'─'.repeat(width - 2)}┐`;
  const mid = `├${'─'.repeat(width - 2)}┤`;
  const bot = `└${'─'.repeat(width - 2)}┘`;

  const s = result.summary;
  const rows = [
    top,
    line(
      `${c.bold(c.brightCyan('SPEEDTEST.AI'))}  ${c.bold(c.white(result.targetName))} ${c.gray(`(${result.model})`)}`
    ),
    line(
      `Grade: ${colorGrade(s.grade)}   Mode: ${c.white(result.mode.toUpperCase())}   Total: ${c.gray(formatMs(s.totalDurationMs))}`
    ),
    mid,
    line(
      `${c.dim('DOWNLOAD (Decode):')}  ${c.bold(colorByTps(s.downloadDecodeTps, formatTps(s.downloadDecodeTps).padEnd(13)))}  ${c.dim('Peak:')} ${colorByTps(s.downloadPeakTps, formatTps(s.downloadPeakTps))}`
    ),
    line(
      `${c.dim('E2E THROUGHPUT:')}     ${c.white(formatTps(s.downloadE2eTps).padEnd(13))}  ${c.dim('Output:')} ${s.downloadOutputTokens} tok ${c.gray(`(${s.tokenSource})`)}`
    ),
    line(
      `${c.dim('PING (TTFT):')}        ${c.white(formatMs(s.pingMs).padEnd(13))}  ${c.dim('Jitter:')} ${formatMs(s.jitterMs)} ${c.gray(`(ITL ${formatMs(s.medianItlMs)})`)}`
    ),
    line(
      `${c.dim('UPLOAD (Prefill):')}   ${c.white(formatTps(s.uploadPrefillTps).padEnd(13))}  ${c.dim('Agent Loop:')} ${formatMs(s.toolLoopMs)}${s.toolLoopVerified ? c.green(' ✓') : ''}`
    ),
  ];

  if (delta) {
    const sign = delta.deltaPct >= 0 ? '+' : '';
    const deltaStr = `${sign}${delta.deltaPct.toFixed(1)}% vs avg ${formatTps(delta.avgDecodeTps)} (${delta.sampleCount} runs)`;
    const coloredDelta = delta.deltaPct >= 0 ? c.brightGreen(deltaStr) : c.yellow(deltaStr);
    rows.push(line(`${c.dim('History:')} ${coloredDelta}`));
  }

  if (s.isBuffered) {
    rows.push(
      line(c.yellow('Note: Target buffered output; decode TPS reflects E2E turn time.'))
    );
  }

  rows.push(bot);
  return rows.join('\n');
}

export async function consumeSpeedtestEvents(
  events: AsyncGenerator<SpeedtestEvent, SpeedtestResult, unknown>,
  options: {
    mode: 'tui' | 'plain' | 'json' | 'jsonl' | 'silent';
    noHistory?: boolean;
  }
): Promise<SpeedtestResult> {
  if (options.mode === 'silent') {
    let finalResult: SpeedtestResult | undefined;
    for await (const ev of events) {
      if (ev.type === 'run:complete') {
        finalResult = ev.result;
      }
    }
    if (!finalResult) throw new Error('Speedtest completed without result.');
    return finalResult;
  }

  if (options.mode === 'jsonl') {
    let finalResult: SpeedtestResult | undefined;
    for await (const ev of events) {
      process.stdout.write(JSON.stringify(ev) + '\n');
      if (ev.type === 'run:complete') {
        finalResult = ev.result;
      }
    }
    if (!finalResult) throw new Error('Speedtest completed without result.');
    return finalResult;
  }

  if (options.mode === 'json') {
    let finalResult: SpeedtestResult | undefined;
    for await (const ev of events) {
      if (ev.type === 'run:complete') {
        finalResult = ev.result;
      }
    }
    if (!finalResult) throw new Error('Speedtest completed without result.');
    process.stdout.write(JSON.stringify(finalResult, null, 2) + '\n');
    return finalResult;
  }

  if (options.mode === 'plain' || !process.stdout.isTTY) {
    let finalResult: SpeedtestResult | undefined;
    for await (const ev of events) {
      if (ev.type === 'run:start') {
        process.stdout.write(
          `Speedtest.ai — ${ev.targetName} (${ev.model || 'default'}) [${ev.mode}]\n`
        );
      } else if (ev.type === 'phase:start') {
        process.stdout.write(`  [${ev.index}/${ev.total}] ${ev.label}...\n`);
      } else if (ev.type === 'phase:complete') {
        const m = ev.metrics;
        const detail =
          ev.phase === 'ping'
            ? `TTFT ${formatMs(m.ttftMs)}`
            : ev.phase === 'download'
              ? `${formatTps(m.decodeTps)} (Peak ${formatTps(m.peakTps)}, TTFT ${formatMs(m.ttftMs)}, Jitter ${formatMs(m.jitterMs)})`
              : ev.phase === 'upload'
                ? `Prefill ${formatTps(m.prefillTps)} (${m.inputTokens} in tok)`
                : `Loop ${formatMs(m.durationMs)}${m.verified ? ' [verified]' : ''}`;
        process.stdout.write(`      -> ${detail}\n`);
      } else if (ev.type === 'phase:skip') {
        process.stdout.write(`      -> skipped (${ev.reason})\n`);
      } else if (ev.type === 'run:complete') {
        finalResult = ev.result;
      }
    }
    if (!finalResult) throw new Error('Speedtest completed without result.');

    const history = options.noHistory ? [] : await loadHistory();
    const delta = compareWithHistory(finalResult, history);
    process.stdout.write('\n' + renderTextCard(finalResult, delta) + '\n');
    return finalResult;
  }

  // Interactive TTY live speedometer dashboard
  let state: LiveDashboardState | undefined;
  let prevLineCount = 0;
  let finalResult: SpeedtestResult | undefined;

  const hideCursor = () => process.stdout.write('\x1b[?25l');
  const showCursor = () => process.stdout.write('\x1b[?25h');

  const clearFrame = () => {
    if (prevLineCount > 0) {
      process.stdout.write(`\x1b[${prevLineCount}A\r\x1b[J`);
      prevLineCount = 0;
    }
  };

  const drawFrame = () => {
    if (!state) return;
    const frame = renderDashboardFrame(state);
    const lines = frame.split('\n');
    const moveUp = prevLineCount > 0 ? `\x1b[${prevLineCount}A\r\x1b[J` : '';
    process.stdout.write(`\x1b[?2026h${moveUp}${frame}\n\x1b[?2026l`);
    prevLineCount = lines.length;
  };

  const onSig = () => {
    showCursor();
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  hideCursor();

  try {
    for await (const ev of events) {
      if (ev.type === 'run:start') {
        state = {
          targetName: ev.targetName,
          model: ev.model || 'default',
          mode: ev.mode,
          phases: ev.phases,
          phaseIndex: 0,
          phaseTotal: ev.phases.length,
          phaseLabel: 'Initializing...',
          tpsHistory: [],
          completedPhases: {},
          skippedPhases: {},
          frameCounter: 0,
        };
        drawFrame();
      } else if (ev.type === 'phase:start' && state) {
        state.currentPhase = ev.phase;
        state.phaseIndex = ev.index;
        state.phaseTotal = ev.total;
        state.phaseLabel = ev.label;
        state.tick = undefined;
        state.frameCounter += 1;
        drawFrame();
      } else if (ev.type === 'gauge:tick' && state) {
        state.tick = ev.tick;
        state.frameCounter += 1;
        if (ev.tick.phase === 'download' && ev.tick.currentTps > 0) {
          state.tpsHistory.push(ev.tick.currentTps);
          if (state.tpsHistory.length > 60) {
            state.tpsHistory.shift();
          }
        }
        drawFrame();
      } else if (ev.type === 'phase:complete' && state) {
        state.completedPhases[ev.phase] = ev.metrics;
        if (ev.metrics.model) {
          state.model = ev.metrics.model;
        }
        drawFrame();
      } else if (ev.type === 'phase:skip' && state) {
        state.skippedPhases[ev.phase] = ev.reason;
        drawFrame();
      } else if (ev.type === 'run:complete') {
        finalResult = ev.result;
      }
    }

    clearFrame();
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
    showCursor();
  }

  if (!finalResult) throw new Error('Speedtest completed without result.');

  const history = options.noHistory ? [] : await loadHistory();
  const delta = compareWithHistory(finalResult, history);
  process.stdout.write(renderRichResultCard(finalResult, delta) + '\n');
  return finalResult;
}

export function renderDetectTable(targets: TargetInfo[]): string {
  const lines: string[] = [];
  lines.push(c.bold('Detected AI Harnesses, Local Runtimes & Cloud Providers:'));
  lines.push('');

  for (const t of targets) {
    const badge = t.available ? c.brightGreen('● READY  ') : c.gray('○ MISSING');
    const idCol = c.bold(t.id.padEnd(11));
    const nameCol = t.name.padEnd(20);
    const catCol = `[${t.category}]`.padEnd(11);
    const reason = t.reason || '';
    lines.push(`  ${badge}  ${idCol} ${nameCol} ${c.gray(catCol)} ${c.dim(reason)}`);
  }
  return lines.join('\n');
}

export function renderCompareTable(results: SpeedtestResult[]): string {
  const sorted = [...results].sort(
    (a, b) => b.summary.downloadDecodeTps - a.summary.downloadDecodeTps
  );
  const maxTps = Math.max(20, ...sorted.map((r) => r.summary.downloadDecodeTps));

  const lines: string[] = [];
  lines.push(c.bold('Speedtest.ai Comparison Leaderboard (Fastest to Slowest):'));
  lines.push('');

  sorted.forEach((r, idx) => {
    const rank = `#${idx + 1}`.padEnd(4);
    const label = `${r.targetId}:${r.model}`.slice(0, 24).padEnd(25);
    const tpsStr = formatTps(r.summary.downloadDecodeTps).padEnd(11);
    const pingStr = formatMs(r.summary.pingMs).padEnd(9);
    const barLen = Math.max(1, Math.round((r.summary.downloadDecodeTps / maxTps) * 24));
    const bar = colorByTps(r.summary.downloadDecodeTps, '█'.repeat(barLen));
    lines.push(
      `  ${c.bold(rank)} ${c.white(label)} ${colorByTps(r.summary.downloadDecodeTps, tpsStr)} ${c.dim(`TTFT ${pingStr}`)} ${bar} ${colorGrade(r.summary.grade)}`
    );
  });

  return lines.join('\n');
}

export function renderHistoryTable(history: SpeedtestResult[], limit = 15): string {
  if (history.length === 0) {
    return c.dim('No speedtest runs recorded yet. Run "speedtest-ai demo" or "speedtest-ai run -t <target>".');
  }

  const recent = history.slice(-limit).reverse();
  const lines: string[] = [c.bold(`Recent Speedtest Runs (showing ${recent.length} of ${history.length}):`), ''];

  for (const r of recent) {
    const ts = r.timestamp.slice(0, 19).replace('T', ' ');
    const target = `${r.targetId}:${r.model}`.slice(0, 22).padEnd(23);
    const dl = formatTps(r.summary.downloadDecodeTps).padEnd(11);
    const ping = formatMs(r.summary.pingMs).padEnd(9);
    lines.push(
      `  ${c.gray(ts)}  ${c.white(target)}  ${colorByTps(r.summary.downloadDecodeTps, dl)}  ${c.dim(`TTFT ${ping}`)}  ${colorGrade(r.summary.grade)}`
    );
  }

  return lines.join('\n');
}
