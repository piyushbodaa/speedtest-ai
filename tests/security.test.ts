import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAdapter } from '../src/adapters/registry.js';
import { appendHistory, getHistoryFilePath } from '../src/core/history.js';
import { runSpeedtest } from '../src/core/runner.js';
import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter, SpeedtestEvent } from '../src/types.js';
import { makeResult } from './helpers/make-result.js';

const SRC = path.resolve(__dirname, '..', 'src');
function sourceFiles(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

describe('network surface', () => {
  it('makes network requests from exactly two places: API adapters and the local runtime probe', () => {
    const users = sourceFiles()
      .filter((file) => /\bfetch\(|https?\.request\(|https?\.get\(|net\.connect\(|new WebSocket\(|dgram\./.test(fs.readFileSync(file, 'utf8')))
      .map(rel)
      .sort();
    expect(users).toEqual(['adapters/providers/http.ts', 'core/detect.ts']);
  });

  it('has no runtime dependencies to pull code from', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(SRC, '..', 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

describe('API keys', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-env-openai';
    process.env.ANTHROPIC_API_KEY = 'sk-env-anthropic';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  async function authHeaderFor(spec: string, opts: { baseUrl?: string; apiKey?: string }): Promise<string | undefined> {
    let seen: string | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = headers.get('authorization') ?? headers.get('x-api-key') ?? undefined;
      throw new Error('stop here');
    }) as typeof fetch;
    try {
      const { adapter, model } = await resolveAdapter({ targetSpec: spec, ...opts });
      const stream = adapter.stream({ phase: 'download', prompt: 'hi', model, signal: new AbortController().signal } as AdapterInvokeRequest);
      // The first chunks only mark the start; keep reading until the request is attempted.
      for (let i = 0; i < 5 && seen === undefined; i++) {
        const step = await stream.next().catch(() => ({ done: true }) as const);
        if (step.done) break;
      }
    } catch {
      // A missing key is an acceptable outcome: nothing was sent.
    } finally {
      globalThis.fetch = realFetch;
    }
    return seen;
  }

  it('sends an environment key to the provider it belongs to', async () => {
    expect(await authHeaderFor('openai:gpt-test', {})).toBe('Bearer sk-env-openai');
  });

  it('never sends an environment key to a custom --base-url', async () => {
    expect(await authHeaderFor('openai:gpt-test', { baseUrl: 'https://example.invalid/v1' })).toBeUndefined();
    expect(await authHeaderFor('anthropic:claude-test', { baseUrl: 'https://example.invalid' })).toBeUndefined();
    expect(await authHeaderFor('myserver:model', { baseUrl: 'https://example.invalid/v1' })).toBeUndefined();
  });

  it('sends a key given on purpose with --api-key to a custom --base-url', async () => {
    expect(await authHeaderFor('myserver:model', { baseUrl: 'https://example.invalid/v1', apiKey: 'sk-explicit' })).toBe('Bearer sk-explicit');
  });
});

describe('agent permissions', () => {
  function adapter(bypass: boolean, calls: string[]): SpeedtestAdapter {
    return {
      id: 'fake', name: 'Fake', category: 'harness', tier: 'verified', supportsToolLoop: true,
      toolLoopBypassesPermissions: bypass,
      async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
        calls.push(req.phase);
        yield { kind: 'start' };
        if (req.phase === 'tool_loop') {
          yield { kind: 'tool_call', toolName: 'Read' };
          yield { kind: 'text', text: fs.readFileSync(path.join(req.cwd!, 'probe.txt'), 'utf8') };
        } else if (req.phase === 'upload') {
          yield { kind: 'text', text: req.prompt.match(/marker=(VERIFY-[A-Z0-9]+)/)?.[1] ?? '' };
        } else {
          for (let i = 0; i < 12; i++) { yield { kind: 'text', text: `word${i} ` }; await new Promise((r) => setTimeout(r, 110)); }
        }
        yield { kind: 'terminal' };
      },
    };
  }
  async function run(bypass: boolean, allow: boolean) {
    const calls: string[] = [];
    const events: SpeedtestEvent[] = [];
    for await (const ev of runSpeedtest({ adapter: adapter(bypass, calls), mode: 'standard', noHistory: true, allowPermissionBypass: allow })) events.push(ev);
    return { calls, events };
  }

  it('does not start a CLI with its permission prompts off unless asked to', async () => {
    const { calls, events } = await run(true, false);
    expect(calls).not.toContain('tool_loop');
    const skip = events.find((e) => e.type === 'phase:skip' && e.phase === 'tool_loop');
    expect(skip && 'reason' in skip ? skip.reason : '').toContain('--allow-permission-bypass');
  }, 20_000);

  it('runs that phase when asked, and always for CLIs that need no bypass', async () => {
    expect((await run(true, true)).calls).toContain('tool_loop');
    expect((await run(false, false)).calls).toContain('tool_loop');
  }, 30_000);
});

describe('history file', () => {
  const saved = process.env.SPEEDTEST_AI_HOME;
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-sec-'));
    process.env.SPEEDTEST_AI_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SPEEDTEST_AI_HOME;
    else process.env.SPEEDTEST_AI_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('keeps measurements but not what the model wrote', async () => {
    const result = makeResult({});
    result.phases.download!.responseText = 'the model answer';
    await appendHistory(result);
    const text = fs.readFileSync(getHistoryFilePath(), 'utf8');
    expect(text).not.toContain('the model answer');
    expect(JSON.parse(text)[0].summary.rankTps).toBe(result.summary.rankTps);
  });

  it.skipIf(process.platform === 'win32')('is readable by its owner only', async () => {
    await appendHistory(makeResult({}));
    expect(fs.statSync(getHistoryFilePath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(home).mode & 0o077).toBe(0);
  });
});
