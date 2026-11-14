import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs, UsageError } from '../src/cli-args.js';
import { buildMenuModel, describeLast, renderSwiftBarMenu } from '../src/core/menu.js';
import { installMenubar, swiftBarPlugin, SWIFTBAR_PLUGIN_NAME, TRAY_SCRIPT } from '../src/core/menubar.js';
import { makeResult, makeTarget } from './helpers/make-result.js';

const targets = [
  makeTarget({ id: 'claude', name: 'Claude Code', category: 'harness', available: true, runnable: true }),
  makeTarget({ id: 'codex', name: 'OpenAI Codex CLI', category: 'harness', available: true, runnable: true }),
  makeTarget({ id: 'agy', name: 'Antigravity CLI', category: 'harness', available: true, runnable: true }),
  makeTarget({ id: 'grok', name: 'Grok CLI', category: 'harness', available: true, runnable: true, authState: 'logged_out', reason: 'not logged in' }),
  makeTarget({ id: 'kimi', name: 'Kimi Code', category: 'harness', available: true, runnable: false, reason: 'no headless mode' }),
  makeTarget({ id: 'gemini', name: 'Gemini CLI', category: 'harness', available: false, runnable: false }),
  makeTarget({ id: 'openai', name: 'OpenAI API', category: 'provider', available: true, runnable: true }),
];
const history = [
  makeResult({ targetId: 'claude', model: 'old', timestamp: '2026-01-01T00:00:00.000Z', summary: { rankTps: 10, ttftMs: 900 } }),
  makeResult({ targetId: 'claude', model: 'new', timestamp: '2026-02-01T00:00:00.000Z', summary: { rankTps: 58.2, ttftMs: 2648 } }),
  makeResult({ targetId: 'agy', model: 'Orchestrator', timestamp: '2026-02-01T00:00:00.000Z', summary: { rankTps: 120, ttftMs: 87000 } }),
];
const model = buildMenuModel(targets, history, { version: 'v9.9.9', command: '/opt/speed test/speedtest-ai' });

describe('menu model', () => {
  it('lists installed agent CLIs only, with the newest result for each', () => {
    expect(model.agents.map((a) => a.id)).toEqual(['claude', 'agy', 'codex', 'grok']);
    expect(model.agents[0].last).toMatchObject({ tps: 58.2, model: 'new', slowStart: false });
    expect(model.unsupported).toEqual([{ id: 'kimi', name: 'Kimi Code', reason: 'no headless mode' }]);
  });

  it('puts a slow start after faster-starting agents and marks a logged-out CLI as not runnable', () => {
    expect(model.agents[1]).toMatchObject({ id: 'agy', last: { slowStart: true } });
    expect(describeLast(model.agents[1])).toBe('120 tok/s · 87s to first token · slow start');
    expect(model.agents.find((a) => a.id === 'grok')).toMatchObject({ runnable: false, reason: 'not logged in' });
    expect(describeLast(model.agents.find((a) => a.id === 'codex')!)).toBe('not tested yet');
  });
});

describe('SwiftBar menu', () => {
  const text = renderSwiftBarMenu(model);

  it('shows the fastest normal result in the menu bar and a test action per runnable agent', () => {
    const lines = text.split('\n');
    expect(lines[0]).toBe('⚡ 58.2');
    expect(text).toContain('Test every agent | bash="/opt/speed test/speedtest-ai" param1="all" terminal=true refresh=true');
    expect(text).toContain('--Test Claude Code | bash="/opt/speed test/speedtest-ai" param1="run" param2="-t" param3="claude" param4="--quick" terminal=true');
    expect(text).not.toContain('--Test Grok CLI');
    expect(text).toContain('--not logged in | color=gray');
  });

  it('neutralises text that would be read as SwiftBar parameters', () => {
    const hostile = buildMenuModel(
      [makeTarget({ id: 'claude', name: 'Evil | bash=/bin/rm param1=-rf\nsecond', category: 'harness', available: true, runnable: true })],
      [makeResult({ targetId: 'claude', model: 'm | href=http://x', summary: { rankTps: 5, ttftMs: 100 } })],
      { version: 'v1', command: '/bin/x' }
    );
    for (const line of renderSwiftBarMenu(hostile).split('\n')) {
      // Every pipe left is one the renderer wrote itself, followed by a known parameter.
      for (const part of line.split('|').slice(1)) expect(part).toMatch(/^ (bash="\/bin\/x"|color=gray|href=https:\/\/krutrimmulyankan\.in|refresh=true)/);
    }
  });
});

describe('menu-bar front ends', () => {
  it.skipIf(process.platform === 'win32')('writes a plugin script that is valid bash and falls back when the CLI is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-menubar-'));
    const file = path.join(dir, SWIFTBAR_PLUGIN_NAME);
    fs.writeFileSync(file, swiftBarPlugin(path.join(dir, "it's missing")), { mode: 0o755 });
    expect(spawnSync('bash', ['-n', file]).status).toBe(0);
    const res = spawnSync('bash', [file], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('speedtest-ai is not installed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the tray script free of anything but its own fixed commands', () => {
    expect(TRAY_SCRIPT).toContain("'^[a-z0-9][a-z0-9-]{0,31}$'");
    expect(TRAY_SCRIPT).toContain('SELFTEST-OK');
    expect(TRAY_SCRIPT).not.toMatch(/Invoke-Expression|iex /);
  });

  it('points Linux users at the Omarchy plugin', () => {
    const outcome = installMenubar('/x/speedtest-ai', 'linux', '/tmp');
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join(' ')).toContain('omarchy plugin add');
  });

  it('parses the menu and menubar commands', () => {
    expect(parseCliArgs(['menu'])).toEqual({ kind: 'menu', format: 'json' });
    expect(parseCliArgs(['menu', '--swiftbar'])).toEqual({ kind: 'menu', format: 'swiftbar' });
    expect(parseCliArgs(['menubar', 'install'])).toEqual({ kind: 'menubar', action: 'install' });
    expect(() => parseCliArgs(['menubar'])).toThrow(UsageError);
    expect(() => parseCliArgs(['detect', '--swiftbar'])).toThrow(UsageError);
  });
});
