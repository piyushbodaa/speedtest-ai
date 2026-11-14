import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { displayWidth } from '../src/tui/ansi.js';

/**
 * Runs the CLI from source in a child process, so signals, exit codes, pipes and stdout purity
 * are the real thing. Only the demo simulator, shell commands and fake CLIs are used: no model is
 * called. SPEEDTEST_AI_DEMO_TIME_SCALE shortens the simulator's delays.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX_LOADER = pathToFileURL(path.join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const CLI_ENTRY = path.join(REPO, 'src', 'cli.ts');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');

const tempDirs: string[] = [];
const children = new Set<ChildProcess>();

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Tests run concurrently, so shared scratch state is only torn down once, at the end.
afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => {});
  }
});

interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

interface CliOptions {
  env?: Record<string, string>;
  cwd?: string;
  home?: string;
  /** Receives the child once it has printed `when` on stdout (or immediately without `when`). */
  act?: { when?: string | RegExp; do: (child: ChildProcess) => void | Promise<void> };
}

async function cli(args: string[], options: CliOptions = {}): Promise<CliRun> {
  const home = options.home ?? (await makeTempDir('speedtest-e2e-home-'));
  const started = Date.now();
  const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
    cwd: options.cwd ?? home,
    env: {
      ...process.env,
      SPEEDTEST_AI_HOME: home,
      SPEEDTEST_AI_DEMO_TIME_SCALE: '0.15',
      NO_COLOR: '1',
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);

  let stdout = '';
  let stderr = '';
  let acted = false;
  const maybeAct = () => {
    const act = options.act;
    if (!act || acted) return;
    if (act.when === undefined || (typeof act.when === 'string' ? stdout.includes(act.when) : act.when.test(stdout))) {
      acted = true;
      void act.do(child);
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    maybeAct();
  });
  child.stdout.on('error', () => {});
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  if (options.act && options.act.when === undefined) maybeAct();

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on('close', (c, s) => resolve([c, s]));
  });
  children.delete(child);
  return { code, signal, stdout, stderr, elapsedMs: Date.now() - started };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeExecutable(file: string, source: string): Promise<void> {
  await writeFile(file, source, 'utf8');
  await chmod(file, 0o755);
}

describe.concurrent('single runs', () => {
  it('prints pure JSON with --json and saves the run to history', { timeout: 30_000 }, async () => {
    const home = await makeTempDir('speedtest-e2e-home-');
    const run = await cli(['demo', '--profile', 'frontier', '--quick', '--json'], { home });
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');

    const result = JSON.parse(run.stdout);
    expect(result).toMatchObject({ schemaVersion: 2, targetId: 'demo', mode: 'quick', runs: 1, tier: 'verified' });
    expect(result.summary.tokenUnit).toBe('normalized');
    expect(result.summary.rankMetric).toBe('decode');
    expect(result.summary.rankTps).toBeGreaterThan(20);
    expect(result.summary.ttftMs).toBeGreaterThan(0);
    expect(['HYPER', 'TURBO', 'CRUISING', 'STEADY', 'CRAWLING']).toContain(result.summary.grade);

    const history = await cli(['history', '--json'], { home });
    expect(history.code).toBe(0);
    const entries = JSON.parse(history.stdout);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(result.id);

    const table = await cli(['history'], { home });
    expect(table.stdout).toContain('demo:demo-frontier-sonnet');
  });

  it('streams valid JSON lines with --jsonl', { timeout: 30_000 }, async () => {
    const run = await cli(['demo', '--profile', 'frontier', '--quick', '--jsonl', '--no-history']);
    expect(run.code).toBe(0);
    const events = parseJsonLines(run.stdout);
    expect(events[0]).toMatchObject({ type: 'run:start', target: 'demo', runs: 1, mode: 'quick' });
    expect(events.some((e) => e.type === 'phase:start')).toBe(true);
    expect(events.filter((e) => e.type === 'gauge:tick').length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'phase:complete')).toBe(true);
    expect(events.at(-1)?.type).toBe('run:complete');
    expect(events.some((e) => e.type === 'run:error')).toBe(false);
  });

  it('repeats the download with --runs and reports the median and range', { timeout: 40_000 }, async () => {
    const run = await cli(['demo', '--profile', 'frontier', '--quick', '--runs', '2', '--jsonl', '--no-history']);
    expect(run.code).toBe(0);
    const events = parseJsonLines(run.stdout);
    expect(events[0]).toMatchObject({ type: 'run:start', runs: 2 });
    expect(events.filter((e) => e.type === 'repeat:complete')).toHaveLength(2);
    const result = events.at(-1)!.result as { runs: number; aggregate: { samples: unknown[]; decodeTpsMin: number; decodeTpsMax: number } };
    expect(result.runs).toBe(2);
    expect(result.aggregate.samples).toHaveLength(2);
    expect(result.aggregate.decodeTpsMin).toBeLessThanOrEqual(result.aggregate.decodeTpsMax);
  });

  it('keeps plain output within 80 columns and shows the caveats', { timeout: 30_000 }, async () => {
    const run = await cli(['demo', '--profile', 'buffered', '--quick', '--plain', '--no-history']);
    expect(run.code).toBe(0);
    for (const line of run.stdout.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);
    expect(run.stdout).toContain('n/a (buffered)');
    expect(run.stdout).toContain('(E2E)');
    expect(run.stdout).toContain('normalized tokens');
    expect(run.stdout).not.toContain('\x1b[');
  });

  it('benchmarks a streaming shell command with -t cmd', { timeout: 30_000 }, async () => {
    const dir = await makeTempDir('speedtest-e2e-cmd-');
    const script = path.join(dir, 'mock-agent.mjs');
    await writeFile(
      script,
      `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 48; i++) {
  process.stdout.write('word' + i + ' routed frame ');
  await sleep(30);
}
`,
      'utf8'
    );
    const run = await cli(['run', '-t', 'cmd', '--cmd', `${process.execPath} ${script} {prompt}`, '--quick', '--json', '--no-history']);
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.targetId).toBe('cmd');
    expect(result.summary.isBuffered).toBe(false);
    expect(result.summary.downloadDecodeTps).toBeGreaterThan(5);
    expect(result.summary.downloadOutputTokens).toBeGreaterThanOrEqual(100);
  });

  it('writes an SVG card, and --card does not swallow the command', { timeout: 40_000 }, async () => {
    const dir = await makeTempDir('speedtest-e2e-card-');
    const explicit = path.join(dir, 'nested', 'card.svg');
    const first = await cli(['demo', '--profile', 'frontier', '--quick', '--plain', '--no-history', '--card', explicit]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`Saved SVG card: ${explicit}`);
    const svg = await readFile(explicit, 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('SPEEDTEST.AI');
    expect(svg).toContain('tok/s');

    const second = await cli(['--card', 'demo', '--profile', 'frontier', '--quick', '--json', '--no-history'], { cwd: dir });
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).targetId).toBe('demo');
    expect(await readFile(path.join(dir, 'speedtest-ai-card.svg'), 'utf8')).toContain('<svg');
  });

  it('reports a failing target on stderr with exit code 1, and as JSON with --json', { timeout: 30_000 }, async () => {
    const plain = await cli(['run', '-t', 'cmd', '--cmd', 'echo boom >&2; exit 3 #', '--quick', '--plain', '--no-history']);
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain('speedtest-ai: custom command failed (exit code 3)');
    expect(plain.stdout).not.toContain('tok/s');

    const json = await cli(['run', '-t', 'cmd', '--cmd', 'exit 3 #', '--quick', '--json', '--no-history']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ error: { target: 'cmd', kind: 'failed' } });

    const jsonl = await cli(['run', '-t', 'cmd', '--cmd', 'exit 3 #', '--quick', '--jsonl', '--no-history']);
    expect(jsonl.code).toBe(1);
    expect(parseJsonLines(jsonl.stdout).at(-1)).toMatchObject({ type: 'run:error', kind: 'failed' });
  });

  it('turns a timeout into an error, never into a result', { timeout: 30_000 }, async () => {
    const home = await makeTempDir('speedtest-e2e-home-');
    const script = 'for i in $(seq 1 200); do printf "word%s lorem ipsum " $i; sleep 0.05; done #';
    const run = await cli(['run', '-t', 'cmd', '--cmd', script, '--quick', '--plain', '--timeout', '1.5'], { home });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('timed out after');
    expect(run.stdout).not.toContain('Grade');
    expect(run.stdout).not.toContain('┌');
    expect(await readdir(home)).toEqual([]);
  });
});

describe.concurrent('compare', () => {
  it('ranks the faster target first and returns one JSON document', { timeout: 40_000 }, async () => {
    const run = await cli(['compare', '-t', 'demo:local,demo:frontier', '--quick', '--json', '--no-history']);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout);
    expect(report).toMatchObject({ schemaVersion: 2, mode: 'quick', interrupted: false, failed: [], notRun: [] });
    expect(report.results.map((r: { model: string }) => r.model)).toEqual(['demo-frontier-sonnet', 'demo-local-q4']);
    expect(report.results[0].summary.rankTps).toBeGreaterThan(report.results[1].summary.rankTps);
  });

  it('ranks a buffered target after a streaming one and gives it no TTFT', { timeout: 40_000 }, async () => {
    const run = await cli(['compare', '-t', 'demo:buffered,demo:local', '--quick', '--json', '--no-history']);
    expect(run.code).toBe(0);
    const { results } = JSON.parse(run.stdout);
    expect(results.map((r: { model: string }) => r.model)).toEqual(['demo-local-q4', 'demo-buffered-b1']);
    expect(results[1].summary).toMatchObject({ isBuffered: true, rankMetric: 'e2e', ttftMs: null, downloadDecodeTps: null });
  });

  it('continues past a failing target: exit 0, leaderboard plus failed list', { timeout: 40_000 }, async () => {
    const args = ['compare', '-t', 'cmd,demo:frontier', '--cmd', 'echo boom >&2; exit 3 #', '--quick', '--no-history'];

    const plain = await cli([...args, '--plain']);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('[1/2]');
    expect(plain.stdout).toContain('✗ failed: custom command failed (exit code 3)');
    expect(plain.stdout).toContain('leaderboard');
    expect(plain.stdout).toMatch(/#1\s+demo:demo-frontier-sonnet/);
    expect(plain.stdout).toContain('Failed / skipped:');
    expect(plain.stdout).toContain('cmd (Custom Command)');
    for (const line of plain.stdout.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);

    const json = await cli([...args, '--json']);
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report.results).toHaveLength(1);
    expect(report.failed).toMatchObject([{ targetId: 'cmd', kind: 'failed' }]);

    const jsonl = await cli([...args, '--jsonl']);
    expect(jsonl.code).toBe(0);
    const events = parseJsonLines(jsonl.stdout);
    expect(events.filter((e) => e.type === 'run:error')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'run:complete')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'batch:complete', interrupted: false });
  });

  it('exits 1 in every output mode when all targets fail', { timeout: 40_000 }, async () => {
    const args = ['compare', '-t', 'cmd', '--cmd', 'exit 3 #', '--quick', '--no-history'];

    const plain = await cli([...args, '--plain']);
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain('No target completed a benchmark:');

    const json = await cli([...args, '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ results: [], failed: [{ targetId: 'cmd' }] });

    const jsonl = await cli([...args, '--jsonl']);
    expect(jsonl.code).toBe(1);
    const events = parseJsonLines(jsonl.stdout);
    expect(events.some((e) => e.type === 'run:error')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'batch:complete', ranking: [] });
  });

  it('validates every target before starting any run', { timeout: 20_000 }, async () => {
    const run = await cli(['compare', '-t', 'demo:frontier,nosuch', '--quick', '--json', '--no-history']);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Unknown target "nosuch"');
    expect(run.elapsedMs).toBeLessThan(5000);
  });
});

describe.concurrent('argument validation', () => {
  const cases: Array<[string[], string]> = [
    [['--bogus'], "Unknown option '--bogus'"],
    [['demo', '--quick', '--full'], '--quick / --full'],
    [['demo', '--runs', '9'], '--runs expects a whole number from 1 to 5'],
    [['demo', '--timeout', 'abc'], '--timeout expects a positive number'],
    [['history', '--limit', '0'], '--limit expects a whole number'],
    [['demo', '--profile', 'nosuch'], 'Unknown demo profile "nosuch"'],
    [['run', '-t', 'nosuch'], 'Unknown target "nosuch"'],
    [['frobnicate'], 'Unknown command "frobnicate"'],
    [['--json'], 'Nothing to run'],
  ];

  it('exits 2 with a message on stderr and nothing on stdout', { timeout: 60_000 }, async () => {
    const runs = await Promise.all(cases.map(([args]) => cli(args)));
    runs.forEach((run, i) => {
      const [args, message] = cases[i];
      expect(run.code, args.join(' ')).toBe(2);
      expect(run.stdout, args.join(' ')).toBe('');
      expect(run.stderr, args.join(' ')).toContain(message);
      expect(run.stderr).toContain('--help');
    });
  });

  it('prints help that fits 80 columns and documents the flags', { timeout: 20_000 }, async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    for (const line of help.stdout.split('\n')) expect(displayWidth(line)).toBeLessThan(80);
    for (const text of ['--runs', '--as-configured', '--include-apis', 'normalized', 'real model tokens', 'EXIT CODES', 'claude']) {
      expect(help.stdout).toContain(text);
    }
    expect(help.stdout).not.toMatch(/RFC 3550|5-8s/);

    const version = await cli(['--version']);
    expect(version.stdout.trim()).toBe('speedtest-ai v0.3.0');
  });
});

describe.concurrent('interrupts and closed pipes', () => {
  const slowDemo = ['demo', '--profile', 'local', '--plain'];

  it('exits 130 on Ctrl-C without a result or a history entry', { timeout: 30_000 }, async () => {
    const home = await makeTempDir('speedtest-e2e-home-');
    const run = await cli(slowDemo, {
      home,
      env: { SPEEDTEST_AI_DEMO_TIME_SCALE: '1' },
      act: { when: 'Download', do: (child) => void child.kill('SIGINT') },
    });
    expect(run.code).toBe(130);
    expect(run.stderr).toContain('speedtest-ai: interrupted.');
    expect(run.stdout).not.toContain('┌');
    expect(run.elapsedMs).toBeLessThan(15_000);
    expect(await readdir(home)).toEqual([]);
  });

  it('stops the whole compare on Ctrl-C and prints the partial leaderboard', { timeout: 40_000 }, async () => {
    const run = await cli(['compare', '-t', 'demo:frontier,demo:local,demo:flash', '--quick', '--plain', '--no-history'], {
      act: { when: '[2/3]', do: (child) => void child.kill('SIGINT') },
    });
    expect(run.code).toBe(130);
    expect(run.stdout).toContain('partial leaderboard (interrupted)');
    expect(run.stdout).toMatch(/#1\s+demo:demo-frontier-sonnet/);
    expect(run.stdout).not.toContain('[3/3]');
    expect(run.stdout).toContain('Not run (interrupted): demo:local, demo:flash');
    expect(run.stderr).toContain('interrupted');
  });

  it('reports an interrupted compare as JSON with the completed results', { timeout: 40_000 }, async () => {
    const run = await cli(['compare', '-t', 'demo:frontier,demo:local', '--quick', '--jsonl', '--no-history'], {
      act: { when: /"type":"run:complete"[\s\S]*"type":"run:start"/, do: (child) => void child.kill('SIGINT') },
    });
    expect(run.code).toBe(130);
    const events = parseJsonLines(run.stdout);
    expect(events.at(-1)).toMatchObject({ type: 'batch:complete', interrupted: true, notRun: ['demo:local'] });
    expect((events.at(-1) as { ranking: unknown[] }).ranking).toHaveLength(1);
    expect(events.some((e) => e.type === 'run:error' && e.kind === 'interrupted')).toBe(true);
  });

  it('exits 143 on SIGTERM', { timeout: 30_000 }, async () => {
    const run = await cli(slowDemo.concat('--no-history'), {
      env: { SPEEDTEST_AI_DEMO_TIME_SCALE: '1' },
      act: { when: 'Download', do: (child) => void child.kill('SIGTERM') },
    });
    expect(run.code).toBe(143);
    expect(run.stderr).toContain('terminated');
  });

  it('kills a child that ignores SIGTERM; a second Ctrl-C exits at once', { timeout: 30_000 }, async () => {
    const dir = await makeTempDir('speedtest-e2e-stubborn-');
    const pidFile = path.join(dir, 'pid');
    const script = path.join(dir, 'stubborn.sh');
    await writeExecutable(script, `#!/bin/sh\ntrap '' TERM INT\necho $$ > ${pidFile}\necho started\nwhile :; do sleep 1; done\n`);
    const args = ['run', '-t', 'cmd', '--cmd', `${script} #`, '--quick', '--jsonl', '--no-history'];

    let interruptedAt = 0;
    const twice = await cli(args, {
      act: {
        when: '"stage":"streaming"',
        do: async (child) => {
          interruptedAt = Date.now();
          child.kill('SIGINT');
          await sleep(150);
          child.kill('SIGINT');
        },
      },
    });
    expect(twice.code).toBe(130);
    expect(Date.now() - interruptedAt).toBeLessThan(1200);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await sleep(200);
    expect(isAlive(pid)).toBe(false);

    const once = await cli(args, {
      act: { when: '"stage":"streaming"', do: (child) => void child.kill('SIGINT') },
    });
    expect(once.code).toBe(130);
    expect(parseJsonLines(once.stdout).at(-1)).toMatchObject({ type: 'run:error', kind: 'interrupted' });
    await sleep(200);
    expect(isAlive(Number((await readFile(pidFile, 'utf8')).trim()))).toBe(false);
  });

  it('stops quietly when the reader closes the pipe', { timeout: 30_000 }, async () => {
    const run = await cli(['demo', '--profile', 'local', '--quick', '--jsonl', '--no-history'], {
      env: { SPEEDTEST_AI_DEMO_TIME_SCALE: '1' },
      act: { when: 'run:start', do: (child) => void child.stdout?.destroy() },
    });
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.elapsedMs).toBeLessThan(10_000);
  });
});

describe.concurrent('history file problems', () => {
  it('survives a corrupt history file and bad entries', { timeout: 40_000 }, async () => {
    const home = await makeTempDir('speedtest-e2e-home-');
    const file = path.join(home, 'history.json');
    await writeFile(file, '{not json', 'utf8');

    const listing = await cli(['history'], { home });
    expect(listing.code).toBe(0);
    expect(listing.stdout).toContain('No speedtest runs recorded yet');
    expect(listing.stderr).toContain('history file was unreadable');
    expect(await readFile(`${file}.corrupt`, 'utf8')).toBe('{not json');

    await writeFile(file, JSON.stringify([{ id: 'x' }, null, { timestamp: 5 }]), 'utf8');
    const run = await cli(['demo', '--profile', 'frontier', '--quick', '--plain'], { home });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('DOWNLOAD');

    const after = await cli(['history', '--json'], { home });
    expect(after.code).toBe(0);
    expect(JSON.parse(after.stdout)).toHaveLength(1);
  });
});

describe.concurrent('all', () => {
  let binDir: string;
  let localRuntimeRunning = false;

  beforeAll(async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'speedtest-e2e-bin-'));
    await symlink(process.execPath, path.join(binDir, 'node'));
    // A machine with Ollama or LM Studio running would benchmark a real local model here.
    const probe = await cli(['detect', '--json'], { env: { PATH: binDir } });
    const targets = JSON.parse(probe.stdout) as Array<{ category: string; available: boolean }>;
    localRuntimeRunning = targets.some((t) => t.category === 'local' && t.available);
    return async () => {
      await rm(binDir, { recursive: true, force: true });
    };
  }, 30_000);

  async function fakeBin(names: { grok?: boolean; agy?: boolean }): Promise<string> {
    const dir = await makeTempDir('speedtest-e2e-fakebin-');
    await symlink(process.execPath, path.join(dir, 'node'));
    if (names.grok) {
      await writeExecutable(
        path.join(dir, 'grok'),
        `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('grok 9.9.9 (fake)'); process.exit(0); }
const lines = fs.readFileSync(${JSON.stringify(path.join(FIXTURES, 'grok-download.jsonl'))}, 'utf8').split('\\n').filter(Boolean);
let i = 0;
const timer = setInterval(() => {
  if (i >= lines.length) return clearInterval(timer);
  process.stdout.write(lines[i++] + '\\n');
}, 25);
`
      );
    }
    if (names.agy) {
      await writeExecutable(
        path.join(dir, 'agy'),
        `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('1.0.0-fake'); process.exit(0); }
process.stderr.write('Error: you are not logged in. Please run agy login\\n');
process.exit(1);
`
      );
    }
    return dir;
  }

  it('exits 2 and never runs the demo when no CLI is detected', { timeout: 30_000 }, async (ctx) => {
    if (localRuntimeRunning) return ctx.skip();
    const plain = await cli(['all', '--plain', '--no-history'], { env: { PATH: binDir } });
    expect(plain.code).toBe(2);
    expect(plain.stderr).toContain('No AI agent CLI that can be benchmarked was detected.');
    expect(plain.stdout).not.toContain('Demo Simulator');

    const json = await cli(['all', '--json', '--no-history'], { env: { PATH: binDir } });
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({ results: [], failed: [] });
  });

  it('benchmarks every detected CLI and exits 0 when one of two fails', { timeout: 40_000 }, async (ctx) => {
    if (localRuntimeRunning) return ctx.skip();
    const dir = await fakeBin({ grok: true, agy: true });

    const plain = await cli(['all', '--plain', '--no-history'], { env: { PATH: dir } });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('Benchmarking 2 targets: agy, grok');
    expect(plain.stdout).toContain('spends model tokens');
    expect(plain.stdout).toMatch(/#1\s+grok:grok-4\.7/);
    expect(plain.stdout).toContain('lean');
    expect(plain.stdout).toContain('Failed / skipped:');
    expect(plain.stdout).toMatch(/agy \(Antigravity CLI\): \[auth\]/);
    for (const line of plain.stdout.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);

    const json = await cli(['all', '--json', '--no-history'], { env: { PATH: dir } });
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report.results).toMatchObject([{ targetId: 'grok', isolation: 'lean', mode: 'quick' }]);
    expect(report.failed).toMatchObject([{ targetId: 'agy', kind: 'failed', failureKind: 'auth' }]);
  });

  it('exits 1 with --json and --jsonl when every detected CLI fails', { timeout: 40_000 }, async (ctx) => {
    if (localRuntimeRunning) return ctx.skip();
    const dir = await fakeBin({ agy: true });

    const json = await cli(['all', '--json', '--no-history'], { env: { PATH: dir } });
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ results: [], failed: [{ targetId: 'agy' }] });

    const jsonl = await cli(['all', '--jsonl', '--no-history'], { env: { PATH: dir } });
    expect(jsonl.code).toBe(1);
    const events = parseJsonLines(jsonl.stdout);
    expect(events.some((e) => e.type === 'run:error' && e.failureKind === 'auth')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'batch:complete', ranking: [] });
  });

  it('detect lists the fake CLIs without running them', { timeout: 30_000 }, async () => {
    const dir = await fakeBin({ grok: true, agy: true });
    await mkdir(path.join(dir, 'unused'), { recursive: true });
    const run = await cli(['detect'], { env: { PATH: dir } });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/READY\s+grok\s+Grok CLI/);
    expect(run.stdout).toMatch(/READY\s+agy/);
    expect(run.stdout).toContain('Agent CLIs not found');
    for (const line of run.stdout.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });
});
