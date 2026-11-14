import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SpeedtestResult } from '../types.js';
import { getHistoryDir } from './history.js';
import { compareResultsByRank, isSlowStart } from './metrics.js';
import { IS_WINDOWS } from './platform.js';

/** The accent each agent CLI uses in its own interface, as in the terminal view. */
const BRAND_HEX: Record<string, string> = {
  claude: '#d97757', codex: '#10a37f', agy: '#4285f4', grok: '#e5e5e5', muse: '#a78bfa', gemini: '#8ab4f8',
  qwen: '#615ced', opencode: '#fab283', copilot: '#8957e5', 'cursor-agent': '#ededed', amp: '#f34e3f', goose: '#ffa500',
};
const KM_BLUE = '#3291ff';

function esc(text: string): string {
  return String(text)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clip(text: string, max: number): string {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const tpsText = (tps: number) => (tps >= 100 ? tps.toFixed(0) : tps.toFixed(1));
const secondsText = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`);

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 675;
const MAX_ROWS = 7;

/**
 * A 16:9 image of the leaderboard, sized for posting. It carries no machine name, user name or
 * path: only agent names, model names and the figures.
 */
export function renderLeaderboardSvg(results: SpeedtestResult[], options: { version: string; date?: Date } = { version: '' }): string {
  const ranked = [...results].sort(compareResultsByRank).slice(0, MAX_ROWS);
  const dropped = results.length - ranked.length;
  const maxTps = Math.max(1, ...ranked.map((r) => r.summary.rankTps));
  const mono = "'Geist Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const sans = "Geist, Inter, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
  const date = (options.date ?? new Date()).toISOString().slice(0, 10);

  const rowHeight = Math.min(74, Math.floor(392 / Math.max(1, ranked.length)));
  // Rows are centred in the space between the two rules.
  const top = 198 + Math.round((392 - rowHeight * ranked.length) / 2) + Math.round(rowHeight / 2) - 6;
  const barX = 470;
  const barMax = 440;

  const rows = ranked
    .map((r, i) => {
      const y = top + i * rowHeight;
      const s = r.summary;
      const color = BRAND_HEX[r.targetId] ?? KM_BLUE;
      const width = Math.max(6, Math.round((s.rankTps / maxTps) * barMax));
      const slow = isSlowStart(r);
      const buffered = s.rankMetric !== 'decode';
      const ttft = typeof s.ttftMs === 'number' ? secondsText(s.ttftMs) : 'n/a';
      const note = buffered ? 'no live stream' : slow ? 'slow start' : '';
      return `
  <text x="64" y="${y + 8}" fill="#6e6e6e" font-family="${mono}" font-size="20">${i + 1}</text>
  <circle cx="108" cy="${y}" r="7" fill="${color}"/>
  <text x="128" y="${y + 1}" fill="#ededed" font-family="${sans}" font-size="25" font-weight="600">${esc(clip(r.targetName, 22))}</text>
  <text x="128" y="${y + 25}" fill="#8f8f8f" font-family="${mono}" font-size="15">${esc(clip(r.model, 34))}</text>
  <rect x="${barX}" y="${y - 12}" width="${barMax}" height="22" rx="4" fill="#161616"/>
  <rect x="${barX}" y="${y - 12}" width="${width}" height="22" rx="4" fill="${color}"${slow || buffered ? ' opacity="0.45"' : ''}/>
  <text x="1004" y="${y + 9}" text-anchor="end" fill="#ffffff" font-family="${mono}" font-size="30" font-weight="700">${tpsText(s.rankTps)}</text>
  <text x="1012" y="${y + 9}" fill="#8f8f8f" font-family="${mono}" font-size="15">tok/s</text>
  <text x="1136" y="${y - 2}" text-anchor="end" fill="#c9c9c9" font-family="${mono}" font-size="17">${ttft}</text>
  <text x="1136" y="${y + 18}" text-anchor="end" fill="${note ? '#f2a20d' : '#6e6e6e'}" font-family="${mono}" font-size="12">${note || 'first token'}</text>`;
    })
    .join('');

  const best = ranked.find((r) => !isSlowStart(r) && r.summary.rankMetric === 'decode') ?? ranked[0];
  const headline = !best
    ? 'No result'
    : ranked.length === 1
      ? `${esc(clip(best.targetName, 24))} answers at ${tpsText(best.summary.rankTps)} tok/s`
      : `${esc(clip(best.targetName, 24))} is fastest here at ${tpsText(best.summary.rankTps)} tok/s`;
  const samples = ranked.some((r) => r.runs > 1) ? 'median of several runs' : 'one sample each';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_CARD_WIDTH}" height="${SHARE_CARD_HEIGHT}" viewBox="0 0 ${SHARE_CARD_WIDTH} ${SHARE_CARD_HEIGHT}">
  <rect width="${SHARE_CARD_WIDTH}" height="${SHARE_CARD_HEIGHT}" fill="#000000"/>
  <rect x="24" y="24" width="${SHARE_CARD_WIDTH - 48}" height="${SHARE_CARD_HEIGHT - 48}" rx="8" fill="#0a0a0a" stroke="#2e2e2e"/>
  <text x="64" y="84" fill="${KM_BLUE}" font-family="${mono}" font-size="16" font-weight="700" letter-spacing="3">KM AI SPEED TEST</text>
  <text x="64" y="132" fill="#ffffff" font-family="${sans}" font-size="38" font-weight="700" letter-spacing="-1">${headline}</text>
  <text x="64" y="164" fill="#8f8f8f" font-family="${sans}" font-size="18">How fast my AI coding agents answer · tokens per second after the first token</text>
  <line x1="64" y1="182" x2="${SHARE_CARD_WIDTH - 64}" y2="182" stroke="#2e2e2e"/>${rows}
  <line x1="64" y1="606" x2="${SHARE_CARD_WIDTH - 64}" y2="606" stroke="#2e2e2e"/>
  <text x="64" y="636" fill="#8f8f8f" font-family="${mono}" font-size="15">krutrimmulyankan.in/speedtest</text>
  <text x="${SHARE_CARD_WIDTH - 64}" y="636" text-anchor="end" fill="#6e6e6e" font-family="${mono}" font-size="14">${esc(clip(`${date} · ${samples}${dropped > 0 ? ` · ${dropped} more not shown` : ''} · ${options.version}`, 70))}</text>
</svg>
`;
}

export function shareCardDir(): string {
  return path.join(getHistoryDir(), 'cards');
}

export interface SavedCard {
  svgPath: string;
  /** Present when a converter on this machine could turn the SVG into a PNG. */
  pngPath?: string;
}

function has(command: string): boolean {
  const probe = IS_WINDOWS ? spawnSync('where', [command], { stdio: 'ignore' }) : spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
}

/** Image hosts and chat apps want a PNG. Uses whichever converter is installed; none is required. */
function convertToPng(svgPath: string, pngPath: string): boolean {
  const attempts: Array<[string, string[]]> = [
    ['rsvg-convert', ['-w', String(SHARE_CARD_WIDTH), '-o', pngPath, svgPath]],
    ['magick', ['-background', 'none', svgPath, pngPath]],
    ['inkscape', [svgPath, '--export-type=png', `--export-filename=${pngPath}`]],
    ['convert', ['-background', 'none', svgPath, pngPath]],
  ];
  for (const [command, args] of attempts) {
    if (!has(command)) continue;
    const res = spawnSync(command, args, { stdio: 'ignore', timeout: 20_000 });
    if (res.status === 0 && fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0) return true;
  }
  return false;
}

/** Writes the card under the results folder, keeping `latest.*` for `speedtest share`. */
export function saveShareCard(svg: string, now = new Date(), options: { png?: boolean } = {}): SavedCard {
  const dir = shareCardDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const svgPath = path.join(dir, `speedtest-${stamp}.svg`);
  fs.writeFileSync(svgPath, svg, { mode: 0o600 });
  fs.copyFileSync(svgPath, path.join(dir, 'latest.svg'));
  pruneOldCards(dir);
  const pngPath = path.join(dir, `speedtest-${stamp}.png`);
  const latestPng = path.join(dir, 'latest.png');
  if (options.png !== false && convertToPng(svgPath, pngPath)) {
    fs.copyFileSync(pngPath, latestPng);
    return { svgPath, pngPath };
  }
  fs.rmSync(latestPng, { force: true });
  return { svgPath };
}

const KEEP_CARDS = 20;

/** Cards are small, but one is written per run; keep the recent ones. */
function pruneOldCards(dir: string): void {
  const stamps = [...new Set(fs.readdirSync(dir).filter((f) => /^speedtest-\d{8}-\d{4}\.(svg|png)$/.test(f)).map((f) => f.slice(0, -4)))].sort();
  for (const stamp of stamps.slice(0, Math.max(0, stamps.length - KEEP_CARDS))) {
    fs.rmSync(path.join(dir, `${stamp}.svg`), { force: true });
    fs.rmSync(path.join(dir, `${stamp}.png`), { force: true });
  }
}

export function latestShareCard(): SavedCard | undefined {
  const dir = shareCardDir();
  const svgPath = path.join(dir, 'latest.svg');
  if (!fs.existsSync(svgPath)) return undefined;
  const pngPath = path.join(dir, 'latest.png');
  return { svgPath, pngPath: fs.existsSync(pngPath) ? pngPath : undefined };
}

/** Puts the image on the clipboard with the platform's own tool. Returns how, or why not. */
export function copyImageToClipboard(pngPath: string): { ok: boolean; detail: string } {
  if (process.platform === 'darwin') {
    const script = `set the clipboard to (read (POSIX file ${JSON.stringify(pngPath)}) as «class PNGf»)`;
    const res = spawnSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 10_000 });
    return res.status === 0 ? { ok: true, detail: 'osascript' } : { ok: false, detail: 'osascript could not set the clipboard' };
  }
  if (IS_WINDOWS) {
    const script =
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing; ' +
      '$img = [System.Drawing.Image]::FromFile($env:SPEEDTEST_SHARE_PNG); [System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose()';
    const res = spawnSync('powershell', ['-NoProfile', '-STA', '-Command', script], {
      stdio: 'ignore',
      timeout: 15_000,
      env: { ...process.env, SPEEDTEST_SHARE_PNG: pngPath },
    });
    return res.status === 0 ? { ok: true, detail: 'powershell' } : { ok: false, detail: 'PowerShell could not set the clipboard' };
  }
  const data = fs.readFileSync(pngPath);
  const tools: Array<[string, string[]]> = [
    ['wl-copy', ['--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i']],
  ];
  for (const [command, args] of tools) {
    if (!has(command)) continue;
    // These tools stay alive to serve the clipboard, so they are detached rather than awaited.
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    child.on('error', () => {});
    child.stdin.end(data);
    child.unref();
    return { ok: true, detail: command };
  }
  return { ok: false, detail: 'no clipboard tool found (install wl-clipboard or xclip)' };
}
