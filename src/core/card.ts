import {
  c,
  displayWidth,
  fitVisible,
  type Palette,
  padRightVisible,
  plainPalette,
  sanitizeInline,
  tpsColor,
  truncateAnsi,
  wrapText,
} from '../tui/ansi.js';
import type { HistoricalDelta, SpeedGrade, SpeedtestResult } from '../types.js';
import { isSlowStart } from './metrics.js';

function xmlEscape(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function gradeHex(grade: SpeedGrade): string {
  switch (grade) {
    case 'HYPER':
      return '#E879F9';
    case 'TURBO':
      return '#34D399';
    case 'CRUISING':
      return '#22D3EE';
    case 'STEADY':
      return '#FBBF24';
    case 'CRAWLING':
      return '#F87171';
    default:
      return '#9CA3AF';
  }
}

export function gradePaint(palette: Palette, grade: SpeedGrade): (s: string) => string {
  const tone =
    grade === 'HYPER'
      ? palette.brightMagenta
      : grade === 'TURBO'
        ? palette.brightGreen
        : grade === 'CRUISING'
          ? palette.brightCyan
          : grade === 'STEADY'
            ? palette.brightYellow
            : palette.brightRed;
  return (s) => palette.bold(tone(s));
}

export function formatTps(tps: number | null | undefined): string {
  if (typeof tps !== 'number' || !Number.isFinite(tps)) return '—';
  return tps >= 100 ? `${tps.toFixed(0)} tok/s` : `${tps.toFixed(1)} tok/s`;
}

export function formatMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)} ms`;
}

/** Headline TTFT text; a buffered target has none. */
export function formatTtft(result: Pick<SpeedtestResult, 'summary'>): string {
  const s = result.summary;
  if (typeof s.ttftMs === 'number') return formatMs(s.ttftMs);
  return s.isBuffered ? 'n/a (buffered)' : '—';
}

/** Grade with the "(E2E)" marker for results ranked on end-to-end rate. */
export function formatGrade(result: Pick<SpeedtestResult, 'summary'>): string {
  return result.summary.rankMetric === 'e2e' ? `${result.summary.grade} (E2E)` : result.summary.grade;
}

/** Caveat tags shown next to a result: buffered / experimental / short / isolation / samples. */
export function resultTags(result: SpeedtestResult): string[] {
  const tags: string[] = [];
  if (result.summary.isBuffered) tags.push('buffered');
  if (result.tier === 'experimental') tags.push('experimental');
  if (result.summary.shortOutput) tags.push('short');
  if (isSlowStart(result)) tags.push('slow start');
  if (result.isolation) tags.push(result.isolation);
  if (result.category === 'demo') tags.push('simulated');
  if (result.runs > 1) {
    const agg = result.aggregate;
    tags.push(agg ? `${result.runs} runs ±${(agg.spreadPct / 2).toFixed(0)}%` : `${result.runs} runs`);
  }
  return tags;
}

/**
 * Splits the room for "<name> (<model>)" so the closing parenthesis always survives: the model is
 * shortened first, then the name.
 */
export function fitNameAndModel(name: string, model: string, budget: number): { name: string; model: string } {
  const cleanName = sanitizeInline(name);
  const cleanModel = sanitizeInline(model);
  const fixed = 3;
  if (displayWidth(cleanName) + displayWidth(cleanModel) + fixed <= budget) {
    return { name: cleanName, model: cleanModel };
  }
  // When both are long the model keeps close to half of the room.
  const minModel = Math.min(displayWidth(cleanModel), Math.max(8, Math.floor(budget * 0.45)));
  const nameRoom = Math.max(4, budget - fixed - minModel);
  const shortName = truncateAnsi(cleanName, nameRoom);
  const modelRoom = Math.max(1, budget - fixed - displayWidth(shortName));
  return { name: shortName, model: truncateAnsi(cleanModel, modelRoom) };
}

interface Cell {
  label: string;
  value: string;
  paint?: (s: string) => string;
}

function uploadCell(result: SpeedtestResult): Cell {
  const s = result.summary;
  const skipped = result.skipped.find((p) => p.phase === 'upload');
  if (skipped) return { label: 'UPLOAD', value: 'failed' };
  if (!result.phases.upload) return { label: 'UPLOAD', value: '—' };
  if (typeof s.uploadPrefillTps === 'number') return { label: 'UPLOAD', value: formatTps(s.uploadPrefillTps) };
  if (typeof s.uploadOverheadMs === 'number') {
    const sign = s.uploadOverheadMs >= 0 ? '+' : '−';
    return { label: 'UPLOAD', value: `${sign}${formatMs(Math.abs(s.uploadOverheadMs))} vs ping` };
  }
  if (typeof s.uploadTtftMs === 'number') return { label: 'UPLOAD', value: `TTFT ${formatMs(s.uploadTtftMs)}` };
  return { label: 'UPLOAD', value: 'done (buffered)' };
}

function toolLoopCell(result: SpeedtestResult): Cell {
  const s = result.summary;
  const skipped = result.skipped.find((p) => p.phase === 'tool_loop');
  if (skipped) return { label: 'Agent loop', value: 'failed' };
  if (!result.phases.tool_loop) return { label: 'Agent loop', value: '—' };
  return { label: 'Agent loop', value: `${formatMs(s.toolLoopMs)}${s.toolLoopVerified ? ' ✓' : ''}` };
}

const PHASE_NAMES: Record<string, string> = {
  ping: 'Ping',
  download: 'Download',
  upload: 'Upload',
  tool_loop: 'Agent loop',
};

/** The free-text lines under the metric grid: vendor counts, repeats, history, caveats. */
function infoLines(result: SpeedtestResult, delta?: HistoricalDelta): Array<{ text: string; tone: 'dim' | 'warn' | 'good' }> {
  const s = result.summary;
  const lines: Array<{ text: string; tone: 'dim' | 'warn' | 'good' }> = [];

  const vendor: string[] = [];
  if (typeof s.reportedOutputTokens === 'number') vendor.push(`${s.reportedOutputTokens} out`);
  if (typeof s.reportedInputTokens === 'number') {
    vendor.push(
      typeof s.cachedInputTokens === 'number' && s.cachedInputTokens > 0
        ? `${s.reportedInputTokens} in (${s.cachedInputTokens} cached)`
        : `${s.reportedInputTokens} in`
    );
  }
  if (typeof s.reportedReasoningTokens === 'number' && s.reportedReasoningTokens > 0) {
    vendor.push(`${s.reportedReasoningTokens} reasoning`);
  }
  if (vendor.length > 0) lines.push({ text: `Vendor-reported tokens: ${vendor.join(' · ')}`, tone: 'dim' });
  if (s.thinkingTokens > 0) {
    lines.push({ text: `Thinking: ${s.thinkingTokens} tok streamed, not counted as output`, tone: 'dim' });
  }
  if (typeof s.costUsd === 'number') {
    lines.push({ text: `Cost: $${s.costUsd.toFixed(4)} (vendor-reported)`, tone: 'dim' });
  }

  const agg = result.aggregate;
  if (agg) {
    const range =
      agg.decodeTpsMin !== null && agg.decodeTpsMax !== null && s.rankMetric === 'decode'
        ? `decode ${agg.decodeTpsMin.toFixed(1)}–${agg.decodeTpsMax.toFixed(1)} tok/s`
        : `E2E ${agg.rankTpsMin.toFixed(1)}–${agg.rankTpsMax.toFixed(1)} tok/s`;
    lines.push({
      text: `Median of ${agg.completed} runs (${agg.requested} requested) · ${range} · spread ${agg.spreadPct.toFixed(1)}%`,
      tone: 'dim',
    });
  } else {
    lines.push({ text: 'Single sample; use --runs 3 for a median and range', tone: 'dim' });
  }

  if (delta) {
    const sign = delta.deltaPct >= 0 ? '+' : '';
    lines.push({
      text: `History: ${sign}${delta.deltaPct.toFixed(1)}% vs avg ${formatTps(delta.avgDecodeTps)} (${delta.sampleCount} earlier ${delta.sampleCount === 1 ? 'run' : 'runs'})`,
      tone: delta.deltaPct >= 0 ? 'good' : 'warn',
    });
  }

  if (s.isBuffered) {
    lines.push({
      text: 'Buffered: the answer did not arrive as a stream, so there is no TTFT or decode rate. Graded on end-to-end tok/s.',
      tone: 'warn',
    });
  }
  if (s.shortOutput) {
    lines.push({
      text: 'Short output: under 2 s or 150 tokens of stream, so the rate is less reliable.',
      tone: 'warn',
    });
  }
  if (result.tier === 'experimental') {
    lines.push({ text: 'Experimental adapter: built from documentation, not verified against this CLI.', tone: 'warn' });
  }
  for (const skipped of result.skipped) {
    lines.push({
      text: `${PHASE_NAMES[skipped.phase] ?? skipped.phase} failed: ${sanitizeInline(skipped.reason)}`,
      tone: 'warn',
    });
  }
  if (typeof s.uploadPrefillTps !== 'number' && s.uploadPrefillReason && result.phases.upload) {
    lines.push({ text: `Upload rate not shown: ${sanitizeInline(s.uploadPrefillReason)}`, tone: 'dim' });
  }
  for (const note of result.notes) {
    lines.push({ text: `Note: ${sanitizeInline(note)}`, tone: 'dim' });
  }
  return lines;
}

export interface CardOptions {
  /** Total box width in terminal cells. Clamped to 30..68. */
  width?: number;
  color?: boolean;
}

const MAX_CARD_WIDTH = 68;
const MIN_CARD_WIDTH = 30;
const MAX_INFO_ROWS_PER_ITEM = 3;

export function renderResultCard(
  result: SpeedtestResult,
  delta?: HistoricalDelta,
  options: CardOptions = {}
): string {
  const p = options.color ? c : plainPalette;
  const width = Math.max(MIN_CARD_WIDTH, Math.min(MAX_CARD_WIDTH, Math.floor(options.width ?? 66)));
  const inner = width - 4;
  const s = result.summary;

  const line = (content: string) => `│ ${fitVisible(content, inner)} │`;
  const top = `┌${'─'.repeat(width - 2)}┐`;
  const mid = `├${'─'.repeat(width - 2)}┤`;
  const bot = `└${'─'.repeat(width - 2)}┘`;

  const brand = inner >= 48 ? 'KM AI SPEED TEST' : 'KM';
  const title = fitNameAndModel(result.targetName, result.model, inner - displayWidth(brand) - 2);
  const rows: string[] = [
    top,
    line(`${p.bold(p.brightCyan(brand))}  ${p.bold(p.white(title.name))} ${p.gray(`(${title.model})`)}`),
    line(
      `${gradePaint(p, s.grade)(formatGrade(result))}  ·  ${p.white(result.mode.toUpperCase())}  ·  ${p.gray(formatMs(s.totalDurationMs))}`
    ),
  ];
  const tags = resultTags(result);
  if (tags.length > 0) {
    for (const tagLine of wrapText(tags.join(' · '), inner)) rows.push(line(p.yellow(tagLine)));
  }
  rows.push(mid);

  const rate = tpsColor(p, s.rankTps);
  const cells: Array<[Cell, Cell]> = [
    [
      {
        label: 'DOWNLOAD',
        value: s.rankMetric === 'decode' ? formatTps(s.downloadDecodeTps) : `${formatTps(s.downloadE2eTps)} (E2E)`,
        paint: (v) => p.bold(rate(v)),
      },
      { label: 'Peak', value: formatTps(s.downloadPeakTps) },
    ],
    [
      { label: 'End-to-end', value: formatTps(s.downloadE2eTps) },
      { label: 'Output', value: `${s.downloadOutputTokens} tok` },
    ],
    [
      { label: 'PING (TTFT)', value: formatTtft(result), paint: p.white },
      { label: 'CLI ready', value: formatMs(s.readyMs) },
    ],
    [
      { label: 'Jitter', value: formatMs(s.jitterMs) },
      { label: 'Max stall', value: formatMs(s.maxStallMs) },
    ],
    [uploadCell(result), toolLoopCell(result)],
  ];

  const renderCell = (cell: Cell, labelWidth: number, cellWidth: number) => {
    const label = p.dim(padRightVisible(cell.label, labelWidth));
    const value = (cell.paint ?? p.white)(truncateAnsi(cell.value, Math.max(1, cellWidth - labelWidth)));
    return fitVisible(`${label}${value}`, cellWidth);
  };

  if (inner >= 52) {
    const leftWidth = Math.max(29, Math.ceil((inner - 2) / 2));
    const rightWidth = inner - 2 - leftWidth;
    for (const [left, right] of cells) {
      rows.push(line(`${renderCell(left, 13, leftWidth)}  ${renderCell(right, 12, rightWidth)}`));
    }
  } else {
    for (const pair of cells) {
      for (const cell of pair) rows.push(line(renderCell(cell, 13, inner)));
    }
  }

  const info = infoLines(result, delta);
  if (info.length > 0) {
    rows.push(mid);
    for (const item of info) {
      const paint = item.tone === 'warn' ? p.yellow : item.tone === 'good' ? p.brightGreen : p.dim;
      const wrapped = wrapText(item.text, inner);
      const shown = wrapped.slice(0, MAX_INFO_ROWS_PER_ITEM);
      if (wrapped.length > shown.length) {
        shown[shown.length - 1] = truncateAnsi(`${shown[shown.length - 1]} …`, inner);
      }
      for (const text of shown) rows.push(line(paint(text)));
    }
  }

  rows.push(line(p.dim('tok/s = normalized tokens')));
  rows.push(bot);
  return rows.join('\n');
}

/** Plain (no colour) result box. `width` is the total box width, 30..68. */
export function renderTextCard(result: SpeedtestResult, delta?: HistoricalDelta, width = 66): string {
  return renderResultCard(result, delta, { width, color: false });
}

function svgTruncate(text: string, maxChars: number): string {
  const clean = sanitizeInline(text);
  const chars = [...clean];
  return chars.length <= maxChars ? clean : `${chars.slice(0, maxChars - 1).join('')}…`;
}

export function renderSvgCard(result: SpeedtestResult): string {
  const s = result.summary;
  const accent = gradeHex(s.grade);
  const maxScale = 200;
  const ratio = Math.max(0, Math.min(1, s.rankTps / maxScale));

  // Semicircle gauge centred at (400, 215), radius 115, sweeping from 180° to 0°.
  const cx = 400;
  const cy = 215;
  const r = 115;
  const angle = Math.PI * (1 - ratio);
  const activeX = cx + r * Math.cos(angle);
  const activeY = cy - r * Math.sin(angle);

  const tpsText = s.rankTps >= 100 ? s.rankTps.toFixed(0) : s.rankTps.toFixed(1);
  const mono = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
  const sans = "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif";

  // The grade pill starts at x=630; at ~12.5 px per glyph the title has room for about 44.
  const title = xmlEscape(svgTruncate(result.targetName, 44));
  const modelLine = xmlEscape(svgTruncate(result.model, 70));
  const tags = resultTags(result);
  const subtitle = xmlEscape(
    svgTruncate(
      [`${result.mode.toUpperCase()}`, `${result.timestamp.slice(0, 19).replace('T', ' ')} UTC`, ...tags].join('  ·  '),
      96
    )
  );
  const rateLabel = s.rankMetric === 'decode' ? 'TOKENS / SEC (DECODE)' : 'TOKENS / SEC (END-TO-END, BUFFERED)';
  const underGauge = xmlEscape(
    s.rankMetric === 'decode'
      ? `Peak ${formatTps(s.downloadPeakTps)} · E2E ${formatTps(s.downloadE2eTps)}`
      : 'No streaming: no TTFT or decode rate'
  );

  const ttftVal = xmlEscape(typeof s.ttftMs === 'number' ? formatMs(s.ttftMs) : 'n/a');
  const ttftSub = xmlEscape(typeof s.ttftMs === 'number' ? `Jitter ${formatMs(s.jitterMs)}` : 'buffered output');
  const upload = uploadCell(result);
  const uploadSub = xmlEscape(
    result.phases.upload && typeof s.uploadPromptTokens === 'number'
      ? `${s.uploadPromptTokens} prompt tok`
      : result.skipped.some((p) => p.phase === 'upload')
        ? 'answer not verified'
        : 'not run in this mode'
  );
  const loop = toolLoopCell(result);
  const loopSub = xmlEscape(
    result.skipped.some((p) => p.phase === 'tool_loop')
      ? 'tool probe failed'
      : result.phases.tool_loop
        ? 'tool probe verified'
        : 'not run for this target'
  );
  const gradeText = xmlEscape(formatGrade(result));

  const tile = (x: number, heading: string, value: string, sub: string, fill = '#F8FAFC') => `
  <rect x="${x}" y="280" width="168" height="112" rx="6" fill="#0a0a0a" stroke="#2e2e2e"/>
  <text x="${x + 16}" y="308" fill="#94A3B8" font-family="${mono}" font-size="11" font-weight="700">${heading}</text>
  <text x="${x + 16}" y="346" fill="${fill}" font-family="${mono}" font-size="20" font-weight="700">${value}</text>
  <text x="${x + 16}" y="374" fill="#64748B" font-family="${mono}" font-size="11">${sub}</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="440" viewBox="0 0 800 440">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#000000"/>
      <stop offset="100%" stop-color="#0a0a0a"/>
    </linearGradient>
    <linearGradient id="arcGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#3291ff"/>
      <stop offset="100%" stop-color="${accent}"/>
    </linearGradient>
  </defs>

  <rect width="800" height="440" rx="8" fill="url(#bg)"/>
  <rect x="16" y="16" width="768" height="408" rx="6" fill="none" stroke="#2e2e2e" stroke-width="1"/>

  <text x="40" y="50" fill="#3291ff" font-family="${mono}" font-size="14" font-weight="700" letter-spacing="2">KM AI SPEED TEST</text>
  <text x="40" y="76" fill="#F9FAFB" font-family="${sans}" font-size="22" font-weight="700">${title}</text>
  <text x="40" y="96" fill="#CBD5E1" font-family="${mono}" font-size="13">${modelLine}</text>
  <text x="40" y="114" fill="#9CA3AF" font-family="${mono}" font-size="11">${subtitle}</text>

  <rect x="610" y="38" width="150" height="34" rx="6" fill="#0a0a0a" stroke="${accent}" stroke-width="1.5"/>
  <text x="685" y="60" text-anchor="middle" fill="${accent}" font-family="${mono}" font-size="13" font-weight="700">${gradeText}</text>

  <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="#2e2e2e" stroke-width="18" stroke-linecap="round"/>
  ${
    ratio > 0.01
      ? `<path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${activeX.toFixed(2)} ${activeY.toFixed(2)}" fill="none" stroke="url(#arcGrad)" stroke-width="18" stroke-linecap="round"/>`
      : ''
  }

  <text x="${cx}" y="190" text-anchor="middle" fill="#F9FAFB" font-family="${mono}" font-size="52" font-weight="800">${xmlEscape(tpsText)}</text>
  <text x="${cx}" y="216" text-anchor="middle" fill="#9CA3AF" font-family="${sans}" font-size="14" font-weight="600">${rateLabel}</text>
  <text x="${cx}" y="242" text-anchor="middle" fill="#6B7280" font-family="${mono}" font-size="12">${underGauge}</text>
  <text x="${cx}" y="262" text-anchor="middle" fill="#4B5563" font-family="${mono}" font-size="10">normalized tokens: one local estimator for every target · krutrimmulyankan.in/speedtest</text>
${tile(40, 'PING (TTFT)', ttftVal, ttftSub)}
${tile(224, 'DOWNLOAD', xmlEscape(formatTps(s.rankTps)), `${s.downloadOutputTokens} tok output`, accent)}
${tile(408, 'UPLOAD', xmlEscape(upload.value), uploadSub)}
${tile(592, 'AGENT LOOP', xmlEscape(loop.value), loopSub)}
</svg>
`;
}
