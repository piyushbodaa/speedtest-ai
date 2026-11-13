import type { HistoricalDelta, SpeedGrade, SpeedtestResult } from '../types.js';

function xmlEscape(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function gradeColor(grade: SpeedGrade): string {
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
  }
}

export function formatTps(tps: number | undefined): string {
  if (tps === undefined || !Number.isFinite(tps)) return '—';
  return tps >= 100 ? `${tps.toFixed(0)} tok/s` : `${tps.toFixed(1)} tok/s`;
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)} ms`;
}

export function renderTextCard(result: SpeedtestResult, delta?: HistoricalDelta): string {
  const width = 62;
  const padLine = (content: string) => {
    const trimmed = content.length > width - 4 ? content.slice(0, width - 4) : content;
    return `│ ${trimmed.padEnd(width - 4, ' ')} │`;
  };

  const s = result.summary;
  const top = `┌${'─'.repeat(width - 2)}┐`;
  const mid = `├${'─'.repeat(width - 2)}┤`;
  const bot = `└${'─'.repeat(width - 2)}┘`;

  const lines: string[] = [
    top,
    padLine(`SPEEDTEST.AI  ·  ${result.targetName} (${result.model})`),
    padLine(`Grade: ${s.grade}  ·  Mode: ${result.mode.toUpperCase()}  ·  ${result.timestamp.slice(0, 19).replace('T', ' ')}Z`),
    mid,
    padLine(`DOWNLOAD (Decode):  ${formatTps(s.downloadDecodeTps).padEnd(14)} Peak: ${formatTps(s.downloadPeakTps)}`),
    padLine(`E2E THROUGHPUT:     ${formatTps(s.downloadE2eTps).padEnd(14)} Tokens: ${s.downloadOutputTokens} (${s.tokenSource})`),
    padLine(`PING (TTFT):        ${formatMs(s.pingMs).padEnd(14)} Jitter: ${formatMs(s.jitterMs)}`),
    padLine(
      `UPLOAD (Prefill):   ${formatTps(s.uploadPrefillTps).padEnd(14)} Agent Loop: ${formatMs(s.toolLoopMs)}`
    ),
  ];

  if (delta) {
    const sign = delta.deltaPct >= 0 ? '+' : '';
    lines.push(
      padLine(
        `History (${delta.sampleCount} runs): ${sign}${delta.deltaPct.toFixed(1)}% vs avg ${formatTps(delta.avgDecodeTps)}`
      )
    );
  }
  if (s.isBuffered) {
    lines.push(padLine('Note: Target buffered output; decode TPS reflects E2E turn time.'));
  }
  lines.push(bot);
  return lines.join('\n');
}

export function renderSvgCard(result: SpeedtestResult): string {
  const s = result.summary;
  const accent = gradeColor(s.grade);
  const maxScale = 200;
  const ratio = Math.max(0, Math.min(1, s.downloadDecodeTps / maxScale));

  // Semicircle gauge arc centered at (400, 215), radius 115, from 180 deg to 0 deg
  const cx = 400;
  const cy = 215;
  const r = 115;
  const startX = cx - r;
  const startY = cy;
  const endX = cx + r;
  const endY = cy;

  const angle = Math.PI * (1 - ratio);
  const activeX = cx + r * Math.cos(angle);
  const activeY = cy - r * Math.sin(angle);
  const largeArc = 0;

  const tpsText = s.downloadDecodeTps >= 100
    ? s.downloadDecodeTps.toFixed(0)
    : s.downloadDecodeTps.toFixed(1);

  const title = xmlEscape(`${result.targetName} · ${result.model}`);
  const subtitle = xmlEscape(
    `Mode: ${result.mode.toUpperCase()}  ·  ${result.timestamp.slice(0, 19).replace('T', ' ')} UTC`
  );
  const pingVal = xmlEscape(formatMs(s.pingMs));
  const jitterVal = xmlEscape(`Jitter ${formatMs(s.jitterMs)}`);
  const dlPeak = xmlEscape(`Peak ${formatTps(s.downloadPeakTps)} · E2E ${formatTps(s.downloadE2eTps)}`);
  const ulVal = xmlEscape(formatTps(s.uploadPrefillTps));
  const ulSub = xmlEscape(
    s.uploadInputTokens ? `${s.uploadInputTokens} input tok` : 'Quick mode skipped'
  );
  const loopVal = xmlEscape(formatMs(s.toolLoopMs));
  const loopSub = xmlEscape(
    s.toolLoopVerified === true
      ? 'Tool probe verified'
      : s.toolLoopVerified === false
        ? 'Tool probe unverified'
        : 'N/A for target'
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="440" viewBox="0 0 800 440">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0B0F19"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
    <linearGradient id="arcGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#22D3EE"/>
      <stop offset="55%" stop-color="#34D399"/>
      <stop offset="100%" stop-color="${accent}"/>
    </linearGradient>
  </defs>

  <rect width="800" height="440" rx="20" fill="url(#bg)"/>
  <rect x="16" y="16" width="768" height="408" rx="14" fill="none" stroke="#1F2937" stroke-width="1.5"/>

  <text x="40" y="54" fill="#22D3EE" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" font-weight="700" letter-spacing="2">SPEEDTEST.AI</text>
  <text x="40" y="80" fill="#F9FAFB" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="22" font-weight="700">${title}</text>
  <text x="40" y="102" fill="#9CA3AF" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${subtitle}</text>

  <rect x="630" y="42" width="130" height="34" rx="17" fill="#111827" stroke="${accent}" stroke-width="1.5"/>
  <text x="695" y="64" text-anchor="middle" fill="${accent}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" font-weight="700">${xmlEscape(s.grade)}</text>

  <!-- Gauge Background Track -->
  <path d="M ${startX} ${startY} A ${r} ${r} 0 0 1 ${endX} ${endY}" fill="none" stroke="#1F2937" stroke-width="18" stroke-linecap="round"/>
  <!-- Active Gauge Arc -->
  ${
    ratio > 0.01
      ? `<path d="M ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${activeX.toFixed(2)} ${activeY.toFixed(2)}" fill="none" stroke="url(#arcGrad)" stroke-width="18" stroke-linecap="round"/>`
      : ''
  }

  <text x="${cx}" y="190" text-anchor="middle" fill="#F9FAFB" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="52" font-weight="800">${xmlEscape(tpsText)}</text>
  <text x="${cx}" y="216" text-anchor="middle" fill="#9CA3AF" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="14" font-weight="600">TOKENS / SEC (DECODE)</text>
  <text x="${cx}" y="242" text-anchor="middle" fill="#6B7280" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${dlPeak}</text>

  <!-- 4 Metric Tiles -->
  <rect x="40" y="280" width="168" height="112" rx="12" fill="#0F172A" stroke="#1E293B"/>
  <text x="56" y="308" fill="#94A3B8" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" font-weight="700">PING (TTFT)</text>
  <text x="56" y="346" fill="#F8FAFC" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="24" font-weight="700">${pingVal}</text>
  <text x="56" y="374" fill="#64748B" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">${jitterVal}</text>

  <rect x="224" y="280" width="168" height="112" rx="12" fill="#0F172A" stroke="#1E293B"/>
  <text x="240" y="308" fill="#94A3B8" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" font-weight="700">DOWNLOAD (GEN)</text>
  <text x="240" y="346" fill="${accent}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="24" font-weight="700">${xmlEscape(formatTps(s.downloadDecodeTps))}</text>
  <text x="240" y="374" fill="#64748B" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">${s.downloadOutputTokens} tok (${xmlEscape(s.tokenSource)})</text>

  <rect x="408" y="280" width="168" height="112" rx="12" fill="#0F172A" stroke="#1E293B"/>
  <text x="424" y="308" fill="#94A3B8" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" font-weight="700">UPLOAD (PREFILL)</text>
  <text x="424" y="346" fill="#F8FAFC" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="24" font-weight="700">${ulVal}</text>
  <text x="424" y="374" fill="#64748B" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">${ulSub}</text>

  <rect x="592" y="280" width="168" height="112" rx="12" fill="#0F172A" stroke="#1E293B"/>
  <text x="608" y="308" fill="#94A3B8" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" font-weight="700">AGENT LOOP</text>
  <text x="608" y="346" fill="#F8FAFC" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="24" font-weight="700">${loopVal}</text>
  <text x="608" y="374" fill="#64748B" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">${loopSub}</text>
</svg>
`;
}
