import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve('dist/cli.js');
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('speedtest-ai CLI end-to-end', () => {
  it('runs demo --quick --json and saves to isolated history', { timeout: 25_000 }, async () => {
    const homeDir = await makeTempDir('speedtest-home-');
    const env = { ...process.env, SPEEDTEST_AI_HOME: homeDir };

    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'demo', '--profile', 'flash', '--quick', '--json'],
      { env }
    );

    const result = JSON.parse(stdout);
    expect(result.targetId).toBe('demo');
    expect(result.mode).toBe('quick');
    expect(result.summary.downloadDecodeTps).toBeGreaterThan(20);
    expect(result.summary.pingMs).toBeGreaterThan(0);
    expect(['HYPER', 'TURBO', 'CRUISING', 'STEADY', 'CRAWLING']).toContain(result.summary.grade);

    const histOut = await execFileAsync(process.execPath, [CLI_PATH, 'history', '--json'], { env });
    const history = JSON.parse(histOut.stdout);
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(1);
    expect(history[0].id).toBe(result.id);
  });

  it('streams valid NDJSON events with --jsonl --quick', { timeout: 25_000 }, async () => {
    const homeDir = await makeTempDir('speedtest-jsonl-');
    const env = { ...process.env, SPEEDTEST_AI_HOME: homeDir };

    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'demo', '--profile', 'local', '--quick', '--jsonl'],
      { env }
    );

    const events = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(events[0].type).toBe('run:start');
    expect(events.some((e) => e.type === 'phase:start')).toBe(true);
    expect(events.filter((e) => e.type === 'gauge:tick').length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'phase:complete')).toBe(true);
    expect(events[events.length - 1].type).toBe('run:complete');
  });

  it('compares demo:flash vs demo:local and ranks flash faster', { timeout: 30_000 }, async () => {
    const homeDir = await makeTempDir('speedtest-compare-');
    const env = { ...process.env, SPEEDTEST_AI_HOME: homeDir };

    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'compare', '-t', 'demo:local,demo:flash', '--quick', '--json'],
      { env }
    );

    const ranked = JSON.parse(stdout);
    expect(ranked.length).toBe(2);
    expect(ranked[0].model).toBe('demo-flash-v2');
    expect(ranked[1].model).toBe('demo-local-q4');
    expect(ranked[0].summary.downloadDecodeTps).toBeGreaterThan(
      ranked[1].summary.downloadDecodeTps
    );
  });

  it('benchmarks a real streaming child-process via -t cmd --cmd', async () => {
    const homeDir = await makeTempDir('speedtest-cmd-');
    const mockScript = path.join(homeDir, 'mock-streaming-agent.mjs');
    await writeFile(
      mockScript,
      `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run() {
  await sleep(60);
  const words = ['Packet', 'switching', 'splits', 'streams', 'into', 'routed', 'frames', 'across', 'optical', 'links.'];
  for (const w of words) {
    process.stdout.write(w + ' ');
    await sleep(30);
  }
}
run();
`,
      'utf8'
    );

    const env = { ...process.env, SPEEDTEST_AI_HOME: homeDir };
    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'run', '-t', 'cmd', '--cmd', `node ${mockScript} {prompt}`, '--quick', '--json'],
      { env }
    );

    const result = JSON.parse(stdout);
    expect(result.targetId).toBe('cmd');
    expect(result.summary.isBuffered).toBe(false);
    expect(result.summary.downloadDecodeTps).toBeGreaterThan(5);
    expect(result.summary.downloadOutputTokens).toBeGreaterThanOrEqual(8);
  });

  it('generates a valid SVG speedtest card with --card', { timeout: 25_000 }, async () => {
    const homeDir = await makeTempDir('speedtest-svg-');
    const svgPath = path.join(homeDir, 'card.svg');
    const env = { ...process.env, SPEEDTEST_AI_HOME: homeDir };

    await execFileAsync(
      process.execPath,
      [CLI_PATH, 'demo', '--quick', '--card', svgPath, '--plain'],
      { env }
    );

    const svg = await readFile(svgPath, 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('SPEEDTEST.AI');
    expect(svg).toContain('tok/s');
  });
});
