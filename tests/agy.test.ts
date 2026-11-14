import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAgyArgs,
  createAgyAdapter,
  createAgyEventParser,
  readAgyConfiguredModel,
} from '../src/adapters/harnesses/agy.js';
import { killAllChildren } from '../src/adapters/utils/spawn.js';
import { isTargetFailedError } from '../src/core/errors.js';
import {
  collect,
  createReplayBin,
  loadFixture,
  makeRequest,
  type ReplayBin,
  visibleText,
} from './helpers/replay-cli.js';

let bin: ReplayBin;
beforeAll(() => {
  bin = createReplayBin();
});
afterAll(() => {
  killAllChildren({ force: true });
  bin.remove();
});

describe('agy event parser (real captures)', () => {
  it('streams text deltas once and ends on the SUCCESS result with its usage', () => {
    const events = loadFixture('agy-download.jsonl');
    const chunks = events.flatMap(createAgyEventParser());
    const result = (events.at(-1) as any).result;

    expect(chunks[0]).toEqual({ kind: 'init', model: 'gemini-4-carbon-low' });
    expect(chunks.filter((c) => c.kind === 'text').length).toBeGreaterThan(8);
    expect(visibleText(chunks)).toBe(result.response);
    expect(chunks.at(-1)).toEqual({
      kind: 'terminal',
      inputTokens: 10693,
      cachedInputTokens: 0,
      outputTokens: 76,
      reasoningTokens: 0,
      apiDurationMs: Math.round(result.duration_seconds * 1000),
    });
    expect(chunks.filter((c) => c.kind === 'terminal')).toHaveLength(1);
  });

  it('labels the run from the settings model when init has none, and reports hidden thinking', () => {
    const events = loadFixture('agy-hidden-thinking.jsonl');
    const chunks = events.flatMap(createAgyEventParser({ fallbackModel: 'Orchestrator (Carbon)' }));

    expect(chunks[0]).toEqual({ kind: 'init', model: 'Orchestrator (Carbon)' });
    expect(visibleText(chunks)).toBe('PONG\n');
    expect(chunks.some((c) => c.kind === 'thinking')).toBe(false);
    expect(chunks.at(-1)).toMatchObject({ kind: 'terminal', outputTokens: 144, reasoningTokens: 138 });

    const unlabeled = events.flatMap(createAgyEventParser());
    expect(unlabeled[0]).toEqual({ kind: 'init', model: undefined });
  });

  it('counts a tool step once and takes the cumulative usage, cached tokens included', () => {
    const chunks = loadFixture('agy-tool.jsonl').flatMap(createAgyEventParser());

    expect(chunks.filter((c) => c.kind === 'tool_call')).toEqual([
      { kind: 'tool_call', toolName: 'read_file' },
    ]);
    expect(chunks.filter((c) => c.kind === 'tool_result')).toHaveLength(1);
    expect(visibleText(chunks)).toBe('ZEBRA-4417\n');
    expect(chunks.at(-1)).toMatchObject({
      kind: 'terminal',
      inputTokens: 13364 + 8811,
      cachedInputTokens: 8811,
      outputTokens: 596,
      reasoningTokens: 490,
    });
  });

  it('throws the first line of the CLI error for an ERROR result', () => {
    const parse = createAgyEventParser();
    let error: unknown;
    try {
      loadFixture('agy-badmodel.jsonl').flatMap(parse);
    } catch (err) {
      error = err;
    }
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as any).kind).toBe('model');
    expect((error as Error).message).toMatch(/^agy: invalid model selection .*no-such-model-xyz/);
    expect((error as Error).message).not.toContain('Available models');
  });

  it('uses the final response only when nothing was streamed', () => {
    const chunks = [
      { event: 'init', init: {} },
      { event: 'result', result: { status: 'SUCCESS', response: 'whole answer' } },
    ].flatMap(createAgyEventParser());
    expect(chunks.map((c) => c.kind)).toEqual(['init', 'text', 'terminal']);
    expect(visibleText(chunks)).toBe('whole answer');
  });

  it('ignores lines that are not agy events', () => {
    const parse = createAgyEventParser();
    expect([null, 'text', 42, [], {}, { event: 'unknown' }, { event: 'step_update' }].flatMap(parse)).toEqual([]);
  });
});

describe('agy arguments', () => {
  it('keeps the configured model and never skips permissions for text phases', () => {
    const args = buildAgyArgs(makeRequest({ prompt: 'hello', timeoutMs: 120_000 }));
    expect(args).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--print-timeout',
      '125s',
    ]);
  });

  it('skips permissions only for the tool loop and passes -m through', () => {
    const args = buildAgyArgs(
      makeRequest({ phase: 'tool_loop', enableReadTool: true, cwd: '/tmp/x', model: 'gemini-4-carbon-low' })
    );
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args.slice(-2)).toEqual(['--model', 'gemini-4-carbon-low']);
    expect(args).not.toContain('--print-timeout');
  });

  it('as-configured keeps slash commands enabled', () => {
    expect(buildAgyArgs(makeRequest({ asConfigured: true }))).not.toContain('--disable-slash-commands');
  });

  it('reads the configured model from the settings file and tolerates a missing or broken one', () => {
    const good = path.join(bin.dir, 'settings.json');
    fs.writeFileSync(good, JSON.stringify({ model: 'Orchestrator (Carbon)', other: 1 }));
    const broken = path.join(bin.dir, 'broken.json');
    fs.writeFileSync(broken, '{not json');

    expect(readAgyConfiguredModel(good)).toBe('Orchestrator (Carbon)');
    expect(readAgyConfiguredModel(broken)).toBeUndefined();
    expect(readAgyConfiguredModel(path.join(bin.dir, 'missing.json'))).toBeUndefined();
  });
});

describe('agy adapter process contract', () => {
  it('declares itself verified with no hardcoded model', () => {
    const adapter = createAgyAdapter('agy');
    expect(adapter).toMatchObject({ id: 'agy', tier: 'verified', supportsToolLoop: true });
    expect(adapter.defaultModel).toBeUndefined();
  });

  it('finishes at the result event without waiting for the CLI to exit', async () => {
    const settings = path.join(bin.dir, 'agy-settings.json');
    fs.writeFileSync(settings, JSON.stringify({ model: 'Orchestrator (Carbon)' }));
    const script = bin.script('agy-ok', 'cat "$FIXTURES/agy-hidden-thinking.jsonl"\nsleep 30');
    const adapter = createAgyAdapter(script, { settingsPath: settings });

    const started = Date.now();
    const chunks = await collect(adapter.stream(makeRequest({ timeoutMs: 60_000 })));

    expect(Date.now() - started).toBeLessThan(5000);
    expect(chunks[0].kind).toBe('start');
    expect(chunks.at(-1)?.kind).toBe('terminal');
    expect(chunks.find((c) => c.kind === 'init')?.model).toBe('Orchestrator (Carbon)');
    expect(visibleText(chunks)).toBe('PONG\n');
    expect(bin.invocations('agy-ok')[0]).toContain('--print-timeout 65s');
    expect(bin.invocations('agy-ok')[0]).not.toContain('--model');
  });

  it('fails with the CLI message for an invalid model', async () => {
    const script = bin.script('agy-bad', 'cat "$FIXTURES/agy-badmodel.jsonl"\nexit 1');
    const adapter = createAgyAdapter(script);

    const error = await collect(adapter.stream(makeRequest({ model: 'no-such-model-xyz' }))).catch((e) => e);
    expect(isTargetFailedError(error)).toBe(true);
    expect(error.kind).toBe('model');
    expect(error.message).toContain('no-such-model-xyz');
    expect(bin.invocations('agy-bad')[0]).toContain('--model no-such-model-xyz');
  });

  it('fails when the stream stops before the result event', async () => {
    const script = bin.script('agy-cut', 'head -n 4 "$FIXTURES/agy-download.jsonl"\necho boom >&2\nexit 3');
    const error = await collect(createAgyAdapter(script).stream(makeRequest())).catch((e) => e);
    expect(isTargetFailedError(error)).toBe(true);
    expect(error.message).toMatch(/ended without its final event \(exit code 3\): boom/);
  });
});
