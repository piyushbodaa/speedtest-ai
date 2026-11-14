import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildClaudeArgs, createClaudeAdapter, createClaudeEventParser } from '../src/adapters/harnesses/claude.js';
import { killAllChildren, settleChildren } from '../src/adapters/utils/spawn.js';
import { isTargetFailedError, type TargetFailedError } from '../src/core/errors.js';
import type { AdapterStreamChunk } from '../src/types.js';
import { isAlive, waitUntil } from './helpers/fake-cli.js';
import {
  createReplayCli,
  drain,
  fixturePath,
  kindsOf,
  readFixture,
  type ReplayCli,
  request,
  textOf,
} from './helpers/replay-agent.js';

function replay(fixture: string): AdapterStreamChunk[] {
  const parse = createClaudeEventParser();
  return readFixture(fixture).flatMap((event) => parse(event));
}

function thrownBy(fn: () => unknown): TargetFailedError {
  try {
    fn();
  } catch (err) {
    expect(isTargetFailedError(err)).toBe(true);
    return err as TargetFailedError;
  }
  throw new Error('expected the parser to throw');
}

describe('claude parser (real captures)', () => {
  it('maps a streamed answer once, with message_start as first activity and result as the terminal event', () => {
    const events = readFixture('claude-stream.jsonl') as any[];
    const chunks = replay('claude-stream.jsonl');
    const result = events.find((e) => e.type === 'result');

    expect(chunks[0]).toEqual({ kind: 'init', model: 'claude-fable-5-2' });
    expect(chunks.filter((c) => c.kind === 'text')).toHaveLength(12);
    // The `assistant` summary repeats the streamed text and must not be counted again.
    expect(textOf(chunks)).toBe(result.result);

    const firstActivity = chunks.findIndex((c) => c.kind === 'activity');
    const firstText = chunks.findIndex((c) => c.kind === 'text');
    expect(firstActivity).toBeGreaterThan(0);
    expect(firstActivity).toBeLessThan(firstText);
    expect(chunks[firstActivity]!.model).toBe('claude-fable-5-2');

    const terminal = chunks.at(-1)!;
    expect(terminal.kind).toBe('terminal');
    const usage = result.usage;
    expect(terminal).toMatchObject({
      inputTokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
      cachedInputTokens: usage.cache_read_input_tokens,
      outputTokens: usage.output_tokens,
      reasoningTokens: 0,
      apiDurationMs: result.duration_api_ms,
      costUsd: result.total_cost_usd,
    });
    expect(chunks.filter((c) => c.kind === 'terminal')).toHaveLength(1);
  });

  it('reports the tool call, its result and the cumulative usage of a two-turn tool loop', () => {
    const chunks = replay('claude-tool-loop.jsonl');
    const toolCalls = chunks.filter((c) => c.kind === 'tool_call');
    expect(toolCalls).toEqual([{ kind: 'tool_call', toolName: 'Read' }]);
    expect(chunks.filter((c) => c.kind === 'tool_result')).toHaveLength(1);
    expect(textOf(chunks)).toBe('PROBE-B48110B6');
    expect(chunks.filter((c) => c.kind === 'activity')).toHaveLength(2);
    expect(chunks.at(-1)).toMatchObject({
      kind: 'terminal',
      inputTokens: 4 + 3121 + 6369,
      cachedInputTokens: 6369,
      outputTokens: 87,
    });
  });

  it('treats hidden thinking as activity, never as text, and reports the thinking tokens from usage', () => {
    const chunks = replay('claude-thinking.jsonl');
    expect(chunks.filter((c) => c.kind === 'thinking')).toHaveLength(0);
    expect(textOf(chunks)).toBe('22');
    const firstText = chunks.findIndex((c) => c.kind === 'text');
    expect(chunks.slice(0, firstText).filter((c) => c.kind === 'activity').length).toBeGreaterThanOrEqual(2);
    expect(chunks.at(-1)).toMatchObject({ kind: 'terminal', outputTokens: 46, reasoningTokens: 43 });
  });

  it('fails with the CLI message and kind "model" for an invalid model', () => {
    const err = thrownBy(() => replay('claude-invalid-model.jsonl'));
    expect(err.kind).toBe('model');
    expect(err.message).toContain("There's an issue with the selected model (definitely-not-a-model-xyz)");
  });
});

describe('claude parser (edge cases)', () => {
  it('streams visible thinking text as thinking chunks', () => {
    const parse = createClaudeEventParser();
    const out = parse({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm ' } },
    });
    expect(out).toEqual([{ kind: 'thinking', text: 'hmm ' }]);
  });

  it('uses the assistant summary only for a message that was not streamed', () => {
    const parse = createClaudeEventParser();
    const out = [
      { type: 'system', subtype: 'init', model: 'claude-x' },
      {
        type: 'assistant',
        message: {
          id: 'msg_a',
          model: 'claude-x',
          content: [
            { type: 'text', text: 'whole answer' },
            { type: 'tool_use', name: 'Read' },
          ],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'whole answer', usage: { output_tokens: 3 } },
    ].flatMap((event) => parse(event));
    expect(textOf(out)).toBe('whole answer');
    expect(out.filter((c) => c.kind === 'tool_call')).toHaveLength(1);
    expect(out.at(-1)).toMatchObject({ kind: 'terminal', outputTokens: 3 });
    expect(out.at(-1)!.inputTokens).toBeUndefined();
  });

  it('falls back to the result text when no text event arrived at all', () => {
    const parse = createClaudeEventParser();
    const out = parse({ type: 'result', subtype: 'success', is_error: false, result: 'PONG', usage: {} });
    expect(kindsOf(out)).toEqual(['text', 'terminal']);
    expect(textOf(out)).toBe('PONG');
  });

  it('throws on an error result instead of emitting a terminal event', () => {
    const parse = createClaudeEventParser();
    const err = thrownBy(() =>
      parse({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 overloaded' })
    );
    expect(err.message).toBe('Claude Code: API Error: 529 overloaded');

    const parse2 = createClaudeEventParser();
    const err2 = thrownBy(() => parse2({ type: 'result', subtype: 'error_max_turns', is_error: false }));
    expect(err2.message).toContain('error_max_turns');
  });

  it('gates on rate_limit_info.status only, and tags the following failure as rate_limit', () => {
    const allowed = createClaudeEventParser();
    expect(
      allowed({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'rejected' } })
    ).toEqual([]);
    expect(
      kindsOf(allowed({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }))
    ).toEqual(['text', 'terminal']);

    const rejected = createClaudeEventParser();
    expect(rejected({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })).toEqual([]);
    const err = thrownBy(() =>
      rejected({
        type: 'assistant',
        message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] },
      })
    );
    expect(err.kind).toBe('rate_limit');
    expect(err.message).toContain("You've hit your limit");
  });

  it('ignores unknown and malformed events', () => {
    const parse = createClaudeEventParser();
    expect(parse(null)).toEqual([]);
    expect(parse('text')).toEqual([]);
    expect(parse({ type: 'system', subtype: 'hook_started' })).toEqual([]);
    expect(parse({ type: 'system', subtype: 'commands_changed', commands: [] })).toEqual([]);
    expect(parse({ type: 'stream_event', event: { type: 'message_stop' } })).toEqual([]);
  });
});

describe('claude arguments', () => {
  it('lean mode uses --safe-mode and keeps the configured model', () => {
    const args = buildClaudeArgs(request({ prompt: 'hello' }));
    expect(args.slice(0, 2)).toEqual(['-p', 'hello']);
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--include-partial-messages']));
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).not.toContain('--model');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
  });

  it('passes -m through and enables only Read for the tool loop', () => {
    const args = buildClaudeArgs(request({ model: 'claude-x', enableReadTool: true }));
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'claude-x']);
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 4)).toEqual([
      '--tools',
      'Read',
      '--allowedTools',
      'Read',
    ]);
    expect(args).toContain('--safe-mode');
  });

  it('as-configured drops the isolation and effort overrides', () => {
    const args = buildClaudeArgs(request({ asConfigured: true }));
    expect(args).not.toContain('--safe-mode');
    expect(args).not.toContain('--disable-slash-commands');
    expect(args).not.toContain('--effort');
    expect(args).toContain('--tools');
  });
});

describe('claude adapter (replayed process)', () => {
  let cli: ReplayCli;
  beforeAll(() => {
    cli = createReplayCli();
  });
  beforeEach(() => cli.reset());
  afterAll(() => {
    killAllChildren({ force: true });
    cli.remove();
  });

  it('is a verified harness with a tool loop', () => {
    const adapter = createClaudeAdapter(cli.bin);
    expect(adapter).toMatchObject({ id: 'claude', category: 'harness', tier: 'verified', supportsToolLoop: true });
  });

  it('stops at the result event without waiting for the process, which is then killed', async () => {
    // No `exit`: the stand-in stays alive after printing, like a CLI that is slow to shut down.
    cli.setScenario({ print: { mode: 'replay', file: fixturePath('claude-stream.jsonl') } });
    const { chunks, error, elapsedMs } = await drain(createClaudeAdapter(cli.bin).stream(request()));

    expect(error).toBeUndefined();
    expect(kindsOf(chunks).slice(0, 3)).toEqual(['start', 'meta', 'init']);
    expect(chunks.at(-1)!.kind).toBe('terminal');
    expect(chunks.filter((c) => c.kind === 'text')).toHaveLength(12);
    expect(elapsedMs).toBeLessThan(3000);
    expect(cli.invocations()[0]).toContain('--safe-mode');

    await settleChildren();
    const [pid] = cli.pids();
    expect(await waitUntil(() => !isAlive(pid!), 3000)).toBe(true);
  });

  it('surfaces an invalid model as a model failure', async () => {
    cli.setScenario({ print: { mode: 'replay', file: fixturePath('claude-invalid-model.jsonl'), exit: 1 } });
    const { error } = await drain(createClaudeAdapter(cli.bin).stream(request({ model: 'definitely-not-a-model-xyz' })));
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as TargetFailedError).kind).toBe('model');
  });

  it('fails when the CLI dies before its result event, quoting stderr', async () => {
    cli.setScenario({ print: { mode: 'exit', exit: 1, stderr: 'Not logged in · Please run /login\n' } });
    const { error, chunks } = await drain(createClaudeAdapter(cli.bin).stream(request()));
    expect(chunks.some((c) => c.kind === 'terminal')).toBe(false);
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as TargetFailedError).kind).toBe('auth');
    expect((error as Error).message).toContain('Not logged in');
  });
});
