import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildGrokArgs,
  createGrokAdapter,
  createGrokEventParser,
  GROK_LEAN_NOTE,
} from '../src/adapters/harnesses/grok.js';
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

describe('grok event parser (real captures)', () => {
  it('separates the thinking summary from visible text and does not repeat the summary message', () => {
    const events = loadFixture('grok-download.jsonl');
    const chunks = events.flatMap(createGrokEventParser());
    const result = events.at(-1) as any;

    expect(chunks[0]).toEqual({ kind: 'init', model: 'grok-4.7' });
    expect(chunks[1]).toEqual({ kind: 'activity', model: 'grok-4.7' });
    expect(chunks.filter((c) => c.kind === 'thinking')).toHaveLength(2);
    expect(chunks.filter((c) => c.kind === 'text')).toHaveLength(63);
    expect(visibleText(chunks)).toBe(result.result);
    // The thinking deltas come before the first visible delta.
    expect(chunks.findIndex((c) => c.kind === 'thinking')).toBeLessThan(
      chunks.findIndex((c) => c.kind === 'text')
    );
  });

  it('reports usage only from the final result, with cached tokens added to the input', () => {
    const chunks = loadFixture('grok-download.jsonl').flatMap(createGrokEventParser());

    expect(chunks.filter((c) => c.kind === 'usage')).toEqual([]);
    expect(chunks.at(-1)).toEqual({
      kind: 'terminal',
      inputTokens: 5391 + 3200,
      cachedInputTokens: 3200,
      outputTokens: 111,
      apiDurationMs: 2963,
      costUsd: 0.013048,
    });
  });

  it('reports cumulative usage for a two-turn tool run, not the last turn', () => {
    const chunks = loadFixture('grok-tool.jsonl').flatMap(createGrokEventParser());

    expect(chunks.filter((c) => c.kind === 'tool_call')).toEqual([
      { kind: 'tool_call', toolName: 'read_file' },
    ]);
    expect(chunks.filter((c) => c.kind === 'tool_result')).toHaveLength(1);
    expect(chunks.filter((c) => c.kind === 'activity')).toHaveLength(2);
    expect(visibleText(chunks)).toBe('ZEBRA-4417');
    expect(chunks.at(-1)).toMatchObject({
      kind: 'terminal',
      inputTokens: 6871 + 10624,
      cachedInputTokens: 10624,
      outputTokens: 115,
    });
  });

  it('keeps the real error message of a failed run', () => {
    const parse = createGrokEventParser();
    let error: unknown;
    try {
      loadFixture('grok-badmodel.jsonl').flatMap(parse);
    } catch (err) {
      error = err;
    }
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as any).kind).toBe('model');
    expect((error as Error).message).toBe(
      `grok: Couldn't set model 'no-such-model-xyz': Invalid params: "unknown model id". Run 'grok models' to see available models.`
    );
  });

  it('falls back to the result subtype when an error carries no message', () => {
    const parse = createGrokEventParser();
    expect(() => parse({ type: 'result', is_error: true, subtype: 'error_max_turns' })).toThrow(
      'grok: run failed (error_max_turns)'
    );
  });

  it('uses the summary message or final result only when nothing was streamed', () => {
    const viaSummary = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'whole answer' }] } },
      { type: 'result', is_error: false, result: 'whole answer', usage: { input_tokens: 3, output_tokens: 2 } },
    ].flatMap(createGrokEventParser());
    expect(viaSummary.map((c) => c.kind)).toEqual(['text', 'terminal']);

    const viaResult = [{ type: 'result', is_error: false, result: 'whole answer' }].flatMap(
      createGrokEventParser()
    );
    expect(viaResult.map((c) => c.kind)).toEqual(['text', 'terminal']);
    expect(visibleText(viaResult)).toBe('whole answer');
  });
});

describe('grok arguments', () => {
  it('lean text phases use a real allow-list instead of the no-op empty --tools', () => {
    const args = buildGrokArgs(makeRequest({ prompt: 'hello' }));
    expect(args).toEqual([
      '-p',
      'hello',
      '--output-format',
      'streaming-messages-json',
      '--include-partial-messages',
      '--no-plan',
      '--no-subagents',
      '--reasoning-effort',
      'low',
      '--disable-web-search',
      '--tools',
      'read_file',
      '--max-turns',
      '1',
    ]);
    expect(args).not.toContain('');
    expect(args).not.toContain('-m');
  });

  it('the tool loop may take several turns and bypasses permission prompts', () => {
    const args = buildGrokArgs(
      makeRequest({ phase: 'tool_loop', enableReadTool: true, cwd: '/tmp/x', model: 'grok-4.6' })
    );
    expect(args).not.toContain('--max-turns');
    expect(args.join(' ')).toContain('--tools read_file,list_dir');
    expect(args.join(' ')).toContain('--permission-mode bypassPermissions');
    expect(args.slice(-2)).toEqual(['-m', 'grok-4.6']);
  });

  it('as-configured leaves tools, plan mode and effort to the user setup', () => {
    const args = buildGrokArgs(makeRequest({ prompt: 'hello', asConfigured: true }));
    expect(args).toEqual([
      '-p',
      'hello',
      '--output-format',
      'streaming-messages-json',
      '--include-partial-messages',
    ]);
  });
});

describe('grok adapter process contract', () => {
  it('finishes at the result event without waiting for the CLI to exit', async () => {
    const script = bin.script('grok-ok', 'cat "$FIXTURES/grok-download.jsonl"\nsleep 30');
    const adapter = createGrokAdapter(script);
    expect(adapter).toMatchObject({ id: 'grok', tier: 'verified', supportsToolLoop: true });

    const started = Date.now();
    const chunks = await collect(adapter.stream(makeRequest()));

    expect(Date.now() - started).toBeLessThan(5000);
    expect(chunks.map((c) => c.kind).slice(0, 3)).toEqual(['start', 'meta', 'note']);
    expect(chunks[2].text).toBe(GROK_LEAN_NOTE);
    expect(chunks.at(-1)?.kind).toBe('terminal');
    expect(chunks.filter((c) => c.kind === 'text')).toHaveLength(63);
  });

  it('attaches no lean note when run as configured', async () => {
    const script = bin.script('grok-asconf', 'cat "$FIXTURES/grok-download.jsonl"');
    const chunks = await collect(createGrokAdapter(script).stream(makeRequest({ asConfigured: true })));
    expect(chunks.some((c) => c.kind === 'note')).toBe(false);
  });

  it('fails with the CLI message for an invalid model', async () => {
    const script = bin.script('grok-bad', 'cat "$FIXTURES/grok-badmodel.jsonl"\nexit 1');
    const error = await collect(
      createGrokAdapter(script).stream(makeRequest({ model: 'no-such-model-xyz' }))
    ).catch((e) => e);

    expect(isTargetFailedError(error)).toBe(true);
    expect(error.kind).toBe('model');
    expect(error.message).toContain("Couldn't set model 'no-such-model-xyz'");
    expect(bin.invocations('grok-bad')[0]).toContain('-m no-such-model-xyz');
  });

  it('fails when the stream stops before the result event', async () => {
    const script = bin.script('grok-cut', 'head -n 20 "$FIXTURES/grok-download.jsonl"\nexit 0');
    const error = await collect(createGrokAdapter(script).stream(makeRequest())).catch((e) => e);
    expect(isTargetFailedError(error)).toBe(true);
    expect(error.message).toMatch(/grok ended without its final event/);
  });
});
