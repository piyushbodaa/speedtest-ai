import type { SpeedtestResult, TargetInfo } from '../types.js';

/** What a menu-bar or tray front end needs: the agent CLIs on this machine and their last result. */
export interface MenuAgent {
  id: string;
  name: string;
  /** Installed, supported and not known to be logged out. */
  runnable: boolean;
  tier: 'verified' | 'experimental';
  /** Why it cannot be tested, when it cannot. */
  reason?: string;
  last?: {
    tps: number;
    /** null when the target did not stream (no time to first token). */
    ttftMs: number | null;
    model: string;
    timestamp: string;
    slowStart: boolean;
    buffered: boolean;
  };
}

export interface MenuModel {
  schemaVersion: 1;
  version: string;
  /** Absolute path of this program, for front ends that start tests. */
  command: string;
  agents: MenuAgent[];
  /** Installed agent CLIs that cannot be tested yet. */
  unsupported: Array<{ id: string; name: string; reason: string }>;
}

const SLOW_START_MS = 30_000;

export function buildMenuModel(
  targets: TargetInfo[],
  history: SpeedtestResult[],
  options: { version: string; command: string }
): MenuModel {
  const latest = new Map<string, SpeedtestResult>();
  for (const entry of history) {
    const seen = latest.get(entry.targetId);
    if (!seen || entry.timestamp > seen.timestamp) latest.set(entry.targetId, entry);
  }

  const agents: MenuAgent[] = [];
  const unsupported: MenuModel['unsupported'] = [];
  for (const target of targets) {
    if (target.category !== 'harness' || !target.available) continue;
    if (!target.runnable) {
      unsupported.push({ id: target.id, name: target.name, reason: target.reason ?? 'not supported yet' });
      continue;
    }
    const result = latest.get(target.id);
    agents.push({
      id: target.id,
      name: target.name,
      runnable: target.authState !== 'logged_out',
      tier: target.tier,
      reason: target.authState === 'logged_out' ? (target.reason ?? 'not logged in') : undefined,
      last: result
        ? {
            tps: result.summary.rankTps,
            ttftMs: result.summary.ttftMs,
            model: result.model,
            timestamp: result.timestamp,
            slowStart: typeof result.summary.ttftMs === 'number' && result.summary.ttftMs >= SLOW_START_MS,
            buffered: result.summary.rankMetric !== 'decode',
          }
        : undefined,
    });
  }
  // Fastest first; slow starts and targets with no live stream after them; untested ones last.
  const group = (a: MenuAgent) => (!a.last ? 2 : a.last.slowStart || a.last.buffered ? 1 : 0);
  agents.sort((a, b) => group(a) - group(b) || (b.last?.tps ?? 0) - (a.last?.tps ?? 0));
  return { schemaVersion: 1, version: options.version, command: options.command, agents, unsupported };
}

function formatTps(tps: number): string {
  return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
}

function formatSeconds(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`;
}

export function describeLast(agent: MenuAgent): string {
  if (!agent.last) return 'not tested yet';
  const parts = [`${formatTps(agent.last.tps)} tok/s`];
  if (agent.last.buffered) parts.push('no live stream');
  else if (agent.last.ttftMs !== null) parts.push(`${formatSeconds(agent.last.ttftMs)} to first token`);
  if (agent.last.slowStart) parts.push('slow start');
  return parts.join(' · ');
}

/**
 * SwiftBar and xbar treat `|` as the start of a line's parameters and act on text that looks like
 * a parameter, so anything that came from a CLI is flattened before it is printed.
 */
function plain(text: string, max = 60): string {
  const cleaned = String(text).replace(/[\x00-\x1f\x7f|]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function quote(value: string): string {
  return `"${value.replace(/["\\]/g, '')}"`;
}

/** The menu in the plain-text format SwiftBar and xbar read from a plugin's standard output. */
export function renderSwiftBarMenu(model: MenuModel): string {
  const run = (args: string[]) =>
    `bash=${quote(model.command)} ${args.map((a, i) => `param${i + 1}=${quote(a)}`).join(' ')} terminal=true refresh=true`;
  const best = model.agents.find((a) => a.last && !a.last.slowStart && !a.last.buffered) ?? model.agents.find((a) => a.last);
  const lines: string[] = [];
  lines.push(best?.last ? `⚡ ${formatTps(best.last.tps)}` : '⚡ AI');
  lines.push('---');
  lines.push(`KM AI Speed Test ${plain(model.version, 12)} | href=https://krutrimmulyankan.in/speedtest`);
  if (model.agents.length === 0) {
    lines.push('No AI agent CLI found on this Mac | color=gray');
  } else {
    lines.push(`Test every agent | ${run(['all'])}`);
    lines.push('---');
    for (const agent of model.agents) {
      lines.push(`${plain(agent.name, 32)}   ${plain(describeLast(agent))}`);
      if (agent.runnable) lines.push(`--Test ${plain(agent.name, 32)} | ${run(['run', '-t', agent.id, '--quick'])}`);
      else lines.push(`--${plain(agent.reason ?? 'cannot be tested', 70)} | color=gray`);
      if (agent.last) {
        lines.push(`--${plain(agent.last.model, 40)} | color=gray`);
        lines.push(`--Tested ${plain(agent.last.timestamp.slice(0, 16).replace('T', ' '), 20)} UTC | color=gray`);
      }
      if (agent.tier === 'experimental') lines.push('--Experimental support | color=gray');
    }
  }
  if (model.unsupported.length > 0) {
    lines.push('---');
    lines.push('Installed, not supported yet | color=gray');
    for (const item of model.unsupported) lines.push(`--${plain(item.name, 32)}: ${plain(item.reason, 60)} | color=gray`);
  }
  lines.push('---');
  lines.push('A test uses real model tokens from your accounts | color=gray');
  lines.push('Refresh | refresh=true');
  return lines.join('\n') + '\n';
}
