import type { BenchmarkMode, GaugeTick, PhaseId, PhaseResult } from '../types.js';
import { formatMs, formatTps } from '../core/card.js';
import { c, colorByTps, padRightVisible, truncateVisible, visibleLength } from './ansi.js';

const SPARK_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function renderSparkline(samples: number[], width = 28): string {
  const sliced = samples.slice(-width);
  const maxVal = Math.max(20, ...sliced);
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
  tick?: GaugeTick;
  tpsHistory: number[];
  completedPhases: Partial<Record<PhaseId, PhaseResult>>;
  skippedPhases: Partial<Record<PhaseId, string>>;
  frameCounter: number;
}

export function renderDashboardFrame(state: LiveDashboardState, boxWidth = 68): string {
  const inner = boxWidth - 4;
  const line = (content: string) => {
    const clipped = visibleLength(content) > inner ? truncateVisible(content, inner) : content;
    return `│ ${padRightVisible(clipped, inner)} │`;
  };
  const hr = `├${'─'.repeat(boxWidth - 2)}┤`;
  const top = `┌${'─'.repeat(boxWidth - 2)}┐`;
  const bot = `└${'─'.repeat(boxWidth - 2)}┘`;

  const spinner = c.brightCyan(SPINNER_FRAMES[state.frameCounter % SPINNER_FRAMES.length]);
  const header = `${c.bold(c.brightCyan('SPEEDTEST.AI'))}  ${c.white(state.targetName)} ${c.gray(`(${state.model})`)}  ${c.dim(`[${state.mode.toUpperCase()}]`)}`;

  const phaseBanner = `${spinner} ${c.bold(`Phase ${state.phaseIndex}/${state.phaseTotal}:`)} ${state.phaseLabel}`;

  const currentTps = state.tick?.currentTps ?? 0;
  const peakTps = state.tick?.peakTps ?? 0;
  const avgTps = state.tick?.averageTps ?? 0;
  const tokens = state.tick?.tokensGenerated ?? 0;
  const elapsedSec = ((state.tick?.elapsedMs ?? 0) / 1000).toFixed(1);

  const dialLines = renderArcDial(currentTps, 200);
  const barLine = `${renderSpeedGaugeBar(currentTps, 200, 34)}  ${c.dim('Peak')} ${colorByTps(peakTps, formatTps(peakTps))}`;
  const sparkLine = `${c.dim('Live TPS:')} ${renderSparkline(state.tpsHistory, 30)}  ${c.dim(`${tokens} tok · ${elapsedSec}s`)}`;

  const pingPhase = state.completedPhases.ping;
  const dlPhase = state.completedPhases.download;
  const ulPhase = state.completedPhases.upload;
  const toolPhase = state.completedPhases.tool_loop;

  const pingVal = pingPhase
    ? formatMs(pingPhase.ttftMs)
    : state.tick?.ttftMs !== undefined
      ? formatMs(state.tick.ttftMs)
      : '…';
  const dlVal = dlPhase
    ? formatTps(dlPhase.decodeTps)
    : state.currentPhase === 'download' && avgTps > 0
      ? `${formatTps(avgTps)} (live)`
      : '…';
  const ulVal = ulPhase
    ? formatTps(ulPhase.prefillTps)
    : state.skippedPhases.upload
      ? 'skipped'
      : state.phases.includes('upload')
        ? 'pending'
        : '—';
  const loopVal = toolPhase
    ? formatMs(toolPhase.durationMs)
    : state.skippedPhases.tool_loop
      ? 'skipped'
      : state.phases.includes('tool_loop')
        ? 'pending'
        : '—';

  const row1 = `${c.dim('PING (TTFT):')} ${c.white(pingVal.padEnd(14))} ${c.dim('DOWNLOAD (GEN):')} ${colorByTps(dlPhase?.decodeTps ?? avgTps, dlVal)}`;
  const row2 = `${c.dim('UPLOAD (PRE):')} ${c.white(ulVal.padEnd(13))} ${c.dim('AGENT LOOP:')} ${c.white(loopVal)}`;

  const streamText = state.tick?.previewText
    ? `${c.dim('Stream:')} ${c.gray(state.tick.previewText)}`
    : state.tick?.statusHint
      ? `${c.dim('Status:')} ${c.gray(state.tick.statusHint)}`
      : `${c.dim('Stream:')} ${c.gray('waiting for first token...')}`;

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
    line(streamText),
    bot,
  ].join('\n');
}
