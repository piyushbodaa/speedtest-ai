import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';
import { appendHistory, loadHistory } from '../src/core/history.js';
import { latestShareCard, renderLeaderboardSvg, saveShareCard, shareCardDir } from '../src/core/share.js';
import { stripAnsi } from '../src/tui/ansi.js';
import { consumeParallel, renderParallelFrame, type ParallelEntry } from '../src/tui/parallel.js';
import type { SpeedtestEvent, SpeedtestResult } from '../src/types.js';
import { makeResult } from './helpers/make-result.js';

const saved = process.env.SPEEDTEST_AI_HOME;
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-ps-'));
  process.env.SPEEDTEST_AI_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.SPEEDTEST_AI_HOME;
  else process.env.SPEEDTEST_AI_HOME = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeRun(result: SpeedtestResult, delayMs: number, fail?: string): ParallelEntry['events'] {
  return (async function* (): AsyncGenerator<SpeedtestEvent, SpeedtestResult, unknown> {
    yield { type: 'run:start', timestamp: '', target: result.targetId, targetName: result.targetName, mode: 'quick', phases: ['download'], runs: 1 } as SpeedtestEvent;
    await new Promise((r) => setTimeout(r, delayMs));
    if (fail) throw new Error(fail);
    yield { type: 'run:complete', result } as SpeedtestEvent;
    return result;
  })();
}

describe('parallel runs', () => {
  it('runs every target at the same time and keeps each outcome, including a failure', async () => {
    const a = makeResult({ id: 'a', targetId: 'claude', targetName: 'Claude Code' });
    const b = makeResult({ id: 'b', targetId: 'codex', targetName: 'OpenAI Codex CLI' });
    const started = Date.now();
    const outcomes = await consumeParallel(
      [
        { id: 'claude', name: 'Claude Code', events: fakeRun(a, 300) },
        { id: 'grok', name: 'Grok CLI', events: fakeRun(a, 100, 'not logged in') },
        { id: 'codex', name: 'OpenAI Codex CLI', events: fakeRun(b, 300) },
      ],
      { mode: 'silent', describeError: (e) => `failed: ${(e as Error).message}` }
    );
    // Three 100-300 ms runs side by side take about as long as the slowest, not their sum.
    expect(Date.now() - started).toBeLessThan(650);
    expect(outcomes.map((o) => o.id)).toEqual(['claude', 'grok', 'codex']);
    expect(outcomes[0].result).toBe(a);
    expect(outcomes[1].result).toBeUndefined();
    expect((outcomes[1].error as Error).message).toBe('not logged in');
    expect(outcomes[2].result).toBe(b);
  });

  it('draws one line per agent in every state, within the width', () => {
    const tick = { phase: 'download', stage: 'streaming', elapsedMs: 5000, currentTps: 54.3, averageTps: 54, peakTps: 60, tokensGenerated: 200, thinkingTokens: 0, previewText: '' } as const;
    const frame = stripAnsi(
      renderParallelFrame(
        [
          { id: 'claude', name: 'Claude Code', tick: { ...tick } },
          { id: 'agy', name: 'Antigravity CLI', tick: { ...tick, stage: 'waiting', tokensGenerated: 0, currentTps: 0, elapsedMs: 42_000 } },
          { id: 'codex', name: 'OpenAI Codex CLI', result: makeResult({ summary: { rankTps: 21.5, ttftMs: 4040 } }) },
          { id: 'grok', name: 'Grok CLI', failed: 'failed: not logged in' },
          { id: 'muse', name: 'Muse Code CLI' },
        ],
        60
      )
    );
    const lines = frame.split('\n');
    expect(lines).toHaveLength(7);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    expect(frame).toContain('5 agents in parallel, 3 still running');
    expect(lines[2]).toMatch(/Claude Code\s+█+░+ 54\.3 tok\/s/);
    expect(lines[3]).toContain('waiting for first token… 42s');
    expect(lines[4]).toContain('✓ 21.5 tok/s · first token 4.04s');
    expect(lines[5]).toContain('✗ failed: not logged in');
    expect(lines[6]).toContain('starting…');
  });

  it('keeps every result when several runs save at the same moment', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => appendHistory(makeResult({ id: `r${i}`, targetId: `t${i}` }))));
    expect((await loadHistory()).map((r) => r.id).sort()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
  });

  it('parses --parallel, --no-card and the share command', () => {
    expect(parseCliArgs(['--parallel'])).toMatchObject({ kind: 'all', run: { parallel: true, noCard: false } });
    expect(parseCliArgs(['claude', 'codex', '-p', '--no-card'])).toMatchObject({ kind: 'compare', run: { parallel: true, noCard: true } });
    expect(parseCliArgs(['share'])).toEqual({ kind: 'share' });
  });
});

describe('share card', () => {
  const results = [
    makeResult({ targetId: 'claude', targetName: 'Claude Code', model: 'claude-opus', summary: { rankTps: 54.3, ttftMs: 3100 } }),
    makeResult({ targetId: 'agy', targetName: 'Antigravity CLI', model: 'Orchestrator', summary: { rankTps: 120, ttftMs: 87_000 } }),
    makeResult({ targetId: 'muse', targetName: 'Muse Code CLI', model: 'muse-spark', summary: { rankTps: 77.5, ttftMs: 5600 } }),
  ];

  it('ranks like the leaderboard and names the fastest normal starter in the headline', () => {
    const svg = renderLeaderboardSvg(results, { version: 'speedtest v9', date: new Date('2026-11-14T00:00:00Z') });
    expect(svg).toContain('Muse Code CLI is fastest here at 77.5 tok/s');
    expect(svg.indexOf('Muse Code CLI</text>')).toBeLessThan(svg.indexOf('Claude Code</text>'));
    expect(svg.indexOf('Claude Code</text>')).toBeLessThan(svg.indexOf('Antigravity CLI</text>'));
    expect(svg).toContain('slow start');
    expect(svg).toContain('2026-11-14');
    expect(renderLeaderboardSvg([results[0]], { version: 'v' })).toContain('Claude Code answers at 54.3 tok/s');
  });

  it('is well-formed and escapes whatever a CLI reports as its name or model', () => {
    const hostile = makeResult({ targetId: 'x', targetName: '</text><script>alert(1)</script>', model: 'a & b "c" <d>', summary: { rankTps: 10, ttftMs: 100 } });
    const svg = renderLeaderboardSvg([hostile], { version: 'v' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;/text&gt;');
    expect(svg).toContain('a &amp; b &quot;c&quot; &lt;d&gt;');
    expect((svg.match(/<text /g) ?? []).length).toBe((svg.match(/<\/text>/g) ?? []).length);
  });

  it('carries nothing that identifies the machine or the user', () => {
    const svg = renderLeaderboardSvg(results, { version: 'speedtest v9' });
    for (const secret of [os.userInfo().username, os.hostname(), os.homedir()]) {
      if (secret && secret.length > 2) expect(svg).not.toContain(secret);
    }
  });

  it('saves the card for the share command and keeps only recent ones', () => {
    expect(latestShareCard()).toBeUndefined();
    // Converting to PNG is covered by the end-to-end run; here only the file bookkeeping matters.
    for (let i = 0; i < 24; i++) saveShareCard(renderLeaderboardSvg(results, { version: 'v' }), new Date(Date.UTC(2026, 0, 1, 0, i)), { png: false });
    const card = latestShareCard();
    expect(card?.svgPath).toBe(path.join(shareCardDir(), 'latest.svg'));
    const stamped = fs.readdirSync(shareCardDir()).filter((f) => /^speedtest-.*\.svg$/.test(f));
    expect(stamped).toHaveLength(20);
    expect(stamped.sort()[0]).toBe('speedtest-20260101-0004.svg');
  });
});
