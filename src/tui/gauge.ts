import { fitNameAndModel, formatMs, formatTps } from '../core/card.js';
import type { BenchmarkMode, GaugeTick, PhaseId, PhaseResult } from '../types.js';
import { c, colorByTps, displayWidth, fitVisible, sanitizeInline, tailToWidth, truncateAnsi } from './ansi.js';

const SPARK_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** The live frame always has this many lines, so a redraw can move up by a known amount. */
export const FRAME_HEIGHT = 15;
export const MAX_FRAME_WIDTH = 68;
/** Below this size the live gauge is replaced by plain line output. */
export const MIN_FRAME_COLUMNS = 40;
export const MIN_FRAME_ROWS = 16;

export function renderSparkline(samples: number[], width = 28): string {
  const sliced = samples.slice(-width);
  // Headroom above the fastest sample, so a steady stream does not render as a solid block.
  const maxVal = Math.max(20, ...sliced) * 1.2;
  const padded: number[] = Array(Math.max(0, width - sliced.length))
    .fill(0)
    .concat(sliced);

  return padded
    .map((val) => {
      if (val <= 0) return c.gray('▁');
      const idx = Math.min(
        SPARK_BLOCKS.length - 1,
        Math.max(0, Math.round((val / maxVal) * (SPARK_BLOCKS.length - 1)))
      );
      return colorByTps(val, SPARK_BLOCKS[idx]);
    })
    .join('');
}

export function renderSpeedGaugeBar(tps: number, maxScale = 200, width = 36): string {
  const ratio = Math.max(0, Math.min(1, tps / maxScale));
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);

  let bar = '';
  for (let i = 0; i < filled; i++) {
    const posTps = (i / width) * maxScale;
    bar += colorByTps(posTps, '█');
  }
  bar += c.gray('░'.repeat(empty));
  return `[${bar}]`;
}

export function renderArcDial(tps: number, maxScale = 200): string[] {
  const ratio = Math.max(0, Math.min(1, tps / maxScale));
  const segCount = 12;
  const activeSegs = Math.round(ratio * segCount);
  const segChars = Array.from({ length: segCount }, (_, i) => {
    const posTps = (i / segCount) * maxScale;
    return i < activeSegs ? colorByTps(posTps, '━') : c.gray('─');
  });

  const leftArc = segChars.slice(0, 4).join('');
  const topArc = segChars.slice(4, 8).join('');
  const rightArc = segChars.slice(8, 12).join('');

  const tpsDisplay = tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
  const readout = colorByTps(tps, c.bold(`${tpsDisplay.padStart(5)} tok/s`));

  return [
    `       ╭${topArc}╮`,
    `    ${leftArc}  ${readout}  ${rightArc}`,
    `   ${c.gray('0')}                     ${c.gray(`${maxScale}+`)}`,
  ];
}

export interface LiveDashboardState {
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

function downloadValue(state: LiveDashboardState): { text: string; tps: number } {
  const download = state.completedPhases.download;
  if (download) {
    if (download.decodeTps !== null) return { text: formatTps(download.decodeTps), tps: download.decodeTps };
    return { text: `${formatTps(download.e2eTps)} (E2E)`, tps: download.e2eTps };
  }
  const avg = state.tick?.averageTps ?? 0;
  if (state.currentPhase === 'download' && avg > 0) return { text: `${formatTps(avg)} (live)`, tps: avg };
  return { text: '…', tps: 0 };
}

function secondaryValue(state: LiveDashboardState, phase: 'upload' | 'tool_loop'): string {
  const done = state.completedPhases[phase];
  if (done) {
    if (phase === 'tool_loop') return formatMs(done.durationMs);
    if (typeof done.prefillTps === 'number') return formatTps(done.prefillTps);
    return done.ttftMs === null ? 'done' : `TTFT ${formatMs(done.ttftMs)}`;
  }
  if (state.skippedPhases[phase]) return 'failed';
  if (!state.phases.includes(phase)) return '—';
  return state.currentPhase === phase ? 'running' : 'pending';
}

function streamLine(state: LiveDashboardState, room: number): string {
  const tick = state.tick;
  const status = (text: string) => `${c.dim('Status:')} ${c.gray(truncateAnsi(text, Math.max(1, room - 8)))}`;
  if (!tick) return status('starting…');
  const seconds = `${(tick.elapsedMs / 1000).toFixed(1)}s`;
  if (tick.stage === 'streaming' && tick.previewText) {
    const preview = tailToWidth(sanitizeInline(tick.previewText), Math.max(1, room - 8));
    return `${c.dim('Stream:')} ${c.gray(preview)}`;
  }
  if (tick.statusHint) return status(sanitizeInline(tick.statusHint));
  if (tick.stage === 'booting') return status(`starting the CLI… ${seconds}`);
  if (tick.stage === 'thinking') {
    return status(
      tick.thinkingTokens > 0 ? `model is thinking… ${tick.thinkingTokens} tok, ${seconds}` : `model is thinking… ${seconds}`
    );
  }
  if (tick.stage === 'streaming') return status(`streaming… ${seconds}`);
  return status(`waiting for the first token… ${seconds}`);
}

/**
 * One frame of the live gauge: exactly FRAME_HEIGHT lines, each exactly `boxWidth` cells wide.
 * The bar and sparkline scale with the width; nothing is ever wider than the box.
 */
export function renderDashboardFrame(state: LiveDashboardState, boxWidth = MAX_FRAME_WIDTH): string {
  const width = Math.max(MIN_FRAME_COLUMNS - 1, Math.min(MAX_FRAME_WIDTH, Math.floor(boxWidth)));
  const inner = width - 4;
  const line = (content: string) => `│ ${fitVisible(content, inner)} │`;
  const hr = `├${'─'.repeat(width - 2)}┤`;
  const top = `┌${'─'.repeat(width - 2)}┐`;
  const bot = `└${'─'.repeat(width - 2)}┘`;

  const brand = inner >= 50 ? 'SPEEDTEST.AI' : 'AI';
  const modeTag = `[${state.mode.toUpperCase()}]`;
  const title = fitNameAndModel(
    state.targetName,
    state.model,
    inner - displayWidth(brand) - 2 - displayWidth(modeTag) - 2
  );
  const header = `${c.bold(c.brightCyan(brand))}  ${c.white(title.name)} ${c.gray(`(${title.model})`)}  ${c.dim(modeTag)}`;

  const spinner = c.brightCyan(SPINNER_FRAMES[state.frameCounter % SPINNER_FRAMES.length]);
  const repeat = state.repeat && state.repeat.of > 1 ? c.dim(`  ·  run ${state.repeat.run}/${state.repeat.of}`) : '';
  const phaseBanner = `${spinner} ${c.bold(`Phase ${state.phaseIndex}/${state.phaseTotal}:`)} ${sanitizeInline(state.phaseLabel)}${repeat}`;

  const currentTps = state.tick?.currentTps ?? 0;
  const peakTps = state.tick?.peakTps ?? 0;
  const tokens = state.tick?.tokensGenerated ?? 0;
  const elapsedSec = ((state.tick?.elapsedMs ?? 0) / 1000).toFixed(1);

  const dialLines = renderArcDial(currentTps, 200);

  const peakText = peakTps > 0 ? formatTps(peakTps) : '—';
  const barWidth = Math.max(8, Math.min(40, inner - 2 - 7 - displayWidth(peakText)));
  const barLine = `${renderSpeedGaugeBar(currentTps, 200, barWidth)}  ${c.dim('Peak')} ${peakTps > 0 ? colorByTps(peakTps, peakText) : c.gray(peakText)}`;

  const counters = `${tokens} tok · ${elapsedSec}s`;
  const sparkLabel = inner >= 50 ? 'Live TPS:' : 'TPS:';
  const sparkWidth = Math.max(4, Math.min(30, inner - displayWidth(sparkLabel) - 3 - displayWidth(counters)));
  const sparkLine = `${c.dim(sparkLabel)} ${renderSparkline(state.tpsHistory, sparkWidth)}  ${c.dim(counters)}`;

  const wide = inner >= 60;
  const cellWidth = Math.floor((inner - 1) / 2);
  const cell = (label: string, value: string, paint: (s: string) => string) => {
    const head = `${label} `;
    const room = Math.max(1, cellWidth - displayWidth(head));
    return fitVisible(`${c.dim(head)}${paint(truncateAnsi(value, room))}`, cellWidth);
  };
  const download = downloadValue(state);
  const row1 = `${cell(wide ? 'PING (TTFT):' : 'TTFT:', pingValue(state), c.white)} ${cell(wide ? 'DOWNLOAD:' : 'DOWN:', download.text, (s) => (download.tps > 0 ? colorByTps(download.tps, s) : c.white(s)))}`;
  const row2 = `${cell(wide ? 'UPLOAD:' : 'UP:', secondaryValue(state, 'upload'), c.white)} ${cell(wide ? 'AGENT LOOP:' : 'LOOP:', secondaryValue(state, 'tool_loop'), c.white)}`;

  return [
    top,
    line(header),
    line(phaseBanner),
    hr,
    line(dialLines[0]),
    line(dialLines[1]),
    line(dialLines[2]),
    line(barLine),
    line(sparkLine),
    hr,
    line(row1),
    line(row2),
    hr,
    line(streamLine(state, inner)),
    bot,
  ].join('\n');
}
