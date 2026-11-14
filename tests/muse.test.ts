import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildMuseArgs,
  createMuseAdapter,
  createMuseEventParser,
  MUSE_FALLBACK_MODEL,
  MUSE_LEAN_NOTE,
  museFallbackNote,
} from '../src/adapters/harnesses/muse.js';
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

function parseError(events: unknown[]): any {
  const parse = createMuseEventParser();
  try {
    events.flatMap(parse);
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('muse event parser (real captures)', () => {
  it('reads the model id, the deltas and the reported usage', () => {
    const events = loadFixture('muse-download.jsonl');
    const chunks = events.flatMap(createMuseEventParser());
    const terminal = events.at(-1) as any;

    expect(chunks[0]).toEqual({ kind: 'init', model: 'muse-spark-1.3' });
    expect(chunks.filter((c) => c.kind === 'text')).toHaveLength(11);
    expect(visibleText(chunks)).toBe(terminal.payload.text);
    expect(chunks.filter((c) => c.kind === 'usage')).toEqual([
      { kind: 'usage', inputTokens: 19999, cachedInputTokens: 0, outputTokens: 741, reasoningTokens: 600 },
    ]);
    expect(chunks.at(-1)).toEqual({ kind: 'terminal' });
    // The "-contributor" provider alias never replaces the model id.
    expect(chunks.filter((c) => c.model).map((c) => c.model)).toEqual(['muse-spark-1.3']);
  });

  it('exposes the provider latency only as extra fields', () => {
    const chunks = loadFixture('muse-download.jsonl').flatMap(createMuseEventParser());
    expect(chunks.filter((c) => c.extra)).toEqual([
      { kind: 'meta', extra: { providerTtftMs: 4279, providerFirstEventMs: 476 } },
    ]);
  });

  it('does not double count cached input, and counts only real tool tasks', () => {
    const chunks = loadFixture('muse-tool.jsonl').flatMap(createMuseEventParser());

    expect(chunks.filter((c) => c.kind === 'tool_call')).toEqual([
      { kind: 'tool_call', toolName: 'read_file' },
    ]);
    expect(chunks.filter((c) => c.kind === 'tool_result')).toEqual([
      { kind: 'tool_result', toolName: 'read_file' },
    ]);
    expect(chunks.find((c) => c.kind === 'usage')).toEqual({
      kind: 'usage',
      inputTokens: 61724,
      cachedInputTokens: 30705,
      outputTokens: 106,
      reasoningTokens: 22,
    });
    // Two model calls, one timing report (the first call).
    expect(chunks.filter((c) => c.extra)).toHaveLength(1);
    expect(visibleText(chunks)).toBe('ZEBRA-4417');
  });

  it('turns run.terminal.failed into a model failure carrying the reason', () => {
    const error = parseError(loadFixture('muse-default-rejected.jsonl'));
    expect(isTargetFailedError(error)).toBe(true);
    expect(error.kind).toBe('model');
    expect(error.message).toBe('muse: model `muse-ember-1.0` does not exist or you lack access');
  });

  it('drops the provider request id from the reason', () => {
    const error = parseError([
      {
        payload_type: 'run.terminal.failed',
        payload: { terminal: 'failed', reason: 'model `x` does not exist or you lack access [request_id=abc-123]' },
      },
    ]);
    expect(error.message).toBe('muse: model `x` does not exist or you lack access');
  });

  it('treats any other terminal state as a failure', () => {
    const error = parseError([
      { payload_type: 'run.terminal.cancelled', payload: { terminal: 'cancelled', reason: null } },
    ]);
    expect(isTargetFailedError(error)).toBe(true);
    expect(error.message).toBe('muse: run ended as cancelled');
  });

  it('rejects the canned local reply that never called the model', () => {
    const error = parseError([
      { payload_type: 'run.output.delta', payload: { text: 'Hi! What can I help you with today?' } },
      { payload_type: 'run.usage', payload: { calls: 0, completed_calls: 0, failed_calls: 0, models: [] } },
      { payload_type: 'run.terminal.completed', payload: { terminal: 'completed', text: 'Hi!' } },
    ]);
    expect(isTargetFailedError(error)).toBe(true);
    expect(error.message).toMatch(/without calling the model/);
  });

  it('uses the terminal text only when nothing was streamed, and ignores foreign lines', () => {
    const chunks = [
      null,
      'plain',
      { type: 'result' },
      { payload_type: 'run.terminal.completed', payload: { terminal: 'completed', text: 'whole answer' } },
    ].flatMap(createMuseEventParser());
    expect(chunks.map((c) => c.kind)).toEqual(['text', 'terminal']);
  });
});

describe('muse arguments', () => {
  it('lean text phases keep the configured model and drop reminders, web tools and personal context', () => {
    expect(buildMuseArgs(makeRequest({ prompt: 'hello' }), '/tmp/empty', undefined)).toEqual([
      'exec',
      '--json',
      '--disable-reminders',
      '--no-session-log',
      '--disable-web-tools',
      '--no-foreign-personal-context',
      '--reasoning-effort',
      'low',
      '--preset',
      'empty',
      '--',
      'hello',
    ]);
  });

  it('the tool loop gets the probe directory as workspace instead of the empty preset', () => {
    const args = buildMuseArgs(
      makeRequest({ phase: 'tool_loop', enableReadTool: true, cwd: '/tmp/probe' }),
      '/tmp/probe',
      'muse-spark-1.3'
    );
    expect(args.join(' ')).toContain('--workspace /tmp/probe --model muse-spark-1.3 -- ');
    expect(args).not.toContain('--preset');
  });

  it('as-configured leaves effort, web tools and personal context alone', () => {
    const args = buildMuseArgs(makeRequest({ prompt: 'hello', asConfigured: true }), '/tmp/empty', undefined);
    expect(args).toEqual(['exec', '--json', '--disable-reminders', '--no-session-log', '--', 'hello']);
  });
});

describe('muse adapter process contract', () => {
  const REJECT_UNLESS_MODEL = [
    'case "$*" in',
    '  *"--model muse-spark-1.3"*) cat "$FIXTURES/muse-download.jsonl"; sleep 30 ;;',
    '  *) cat "$FIXTURES/muse-default-rejected.jsonl"; echo "run ended with Failed" >&2; exit 1 ;;',
    'esac',
  ].join('\n');

  it('declares itself verified with no hardcoded default model', () => {
    const adapter = createMuseAdapter('muse');
    expect(adapter).toMatchObject({ id: 'muse', tier: 'verified', supportsToolLoop: true });
    expect(adapter.defaultModel).toBeUndefined();
  });

  it('uses the configured model when muse accepts it', async () => {
    const script = bin.script('muse-ok', 'cat "$FIXTURES/muse-download.jsonl"\nsleep 30');
    const started = Date.now();
    const chunks = await collect(createMuseAdapter(script).stream(makeRequest()));

    expect(Date.now() - started).toBeLessThan(5000);
    expect(bin.invocations('muse-ok')).toHaveLength(1);
    expect(bin.invocations('muse-ok')[0]).not.toContain('--model');
    expect(chunks.filter((c) => c.kind === 'note').map((c) => c.text)).toEqual([MUSE_LEAN_NOTE]);
    expect(chunks.at(-1)?.kind).toBe('terminal');
  });

  it('retries once with the fallback model when the configured default is rejected, and says so', async () => {
    const script = bin.script('muse-retry', REJECT_UNLESS_MODEL);
    const adapter = createMuseAdapter(script);

    const chunks = await collect(adapter.stream(makeRequest()));

    const calls = bin.invocations('muse-retry');
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain('--model');
    expect(calls[1]).toContain(`--model ${MUSE_FALLBACK_MODEL}`);

    // The clock restarts with the second spawn and the note follows its first event.
    const lastStart = chunks.map((c) => c.kind).lastIndexOf('start');
    expect(chunks.filter((c) => c.kind === 'start')).toHaveLength(2);
    expect(chunks.slice(lastStart, lastStart + 4).map((c) => c.kind)).toEqual(['start', 'meta', 'note', 'note']);
    expect(chunks.filter((c) => c.kind === 'note').map((c) => c.text)).toContain(
      museFallbackNote('muse-ember-1.0')
    );
    expect(museFallbackNote('muse-ember-1.0')).toBe(
      'muse: the configured default model muse-ember-1.0 was rejected by muse exec; measured muse-spark-1.3 instead'
    );
    expect(chunks.filter((c) => c.model).at(-1)?.model).toBe('muse-spark-1.3');
    expect(chunks.find((c) => c.kind === 'usage')).toMatchObject({ outputTokens: 741, reasoningTokens: 600 });
    expect(chunks.at(-1)?.kind).toBe('terminal');
    expect(visibleText(chunks)).toMatch(/^1\. TCP congestion control/);

    // Later phases of the same adapter go straight to the fallback, still with the note.
    const again = await collect(adapter.stream(makeRequest({ phase: 'upload' })));
    expect(bin.invocations('muse-retry')).toHaveLength(3);
    expect(again.filter((c) => c.kind === 'start')).toHaveLength(1);
    expect(again.filter((c) => c.kind === 'note').map((c) => c.text)).toContain(
      museFallbackNote('muse-ember-1.0')
    );
  });

  it('does not retry when the user chose the model', async () => {
    const script = bin.script('muse-explicit', REJECT_UNLESS_MODEL);
    const error = await collect(
      createMuseAdapter(script).stream(makeRequest({ model: 'no-such-model-xyz' }))
    ).catch((e) => e);

    expect(isTargetFailedError(error)).toBe(true);
    expect(error.kind).toBe('model');
    expect(error.message).toContain('does not exist or you lack access');
    expect(bin.invocations('muse-explicit')).toHaveLength(1);
    expect(bin.invocations('muse-explicit')[0]).toContain('--model no-such-model-xyz');
  });

  it('does not retry on other failures', async () => {
    const script = bin.script('muse-crash', 'head -n 5 "$FIXTURES/muse-download.jsonl"\necho "401 unauthorized" >&2\nexit 1');
    const error = await collect(createMuseAdapter(script).stream(makeRequest())).catch((e) => e);

    expect(isTargetFailedError(error)).toBe(true);
    expect(error.kind).toBe('auth');
    expect(bin.invocations('muse-crash')).toHaveLength(1);
  });
});
