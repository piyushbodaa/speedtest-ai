import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCodexAppServerArgs,
  codexLeanFlags,
  createCodexAppServerSession,
  parseCodexConfig,
} from '../src/adapters/harnesses/codex-app-server.js';
import { buildCodexExecArgs, createCodexAdapter, createCodexExecParser } from '../src/adapters/harnesses/codex.js';
import { killAllChildren, settleChildren } from '../src/adapters/utils/spawn.js';
import {
  InterruptedError,
  isInterruptedError,
  isTargetFailedError,
  type TargetFailedError,
} from '../src/core/errors.js';
import type { AdapterInvokeRequest, AdapterStreamChunk } from '../src/types.js';
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

const NO_CONFIG = { mcpServers: [] };

function session(req: AdapterInvokeRequest = request()) {
  const sent: any[] = [];
  let deadlineCancelled = false;
  let deadlineError: (() => Error) | undefined;
  const s = createCodexAppServerSession({
    io: {
      send: (message) => {
        sent.push(message);
        return true;
      },
      setDeadline: (_ms, makeError) => {
        deadlineError = makeError;
        return () => {
          deadlineCancelled = true;
        };
      },
    },
    req,
    cwd: '/tmp/probe',
  });
  s.start();
  return {
    s,
    sent,
    feed: (events: unknown[]): AdapterStreamChunk[] => events.flatMap((event) => s.parse(event)),
    deadline: () => ({ cancelled: deadlineCancelled, error: deadlineError?.() }),
  };
}

function thrownBy(fn: () => unknown): TargetFailedError {
  try {
    fn();
  } catch (err) {
    expect(isTargetFailedError(err)).toBe(true);
    return err as TargetFailedError;
  }
  throw new Error('expected a throw');
}

describe('codex app-server session (real captures)', () => {
  it('performs the handshake and maps agent message deltas to text', () => {
    const { s, sent, feed, deadline } = session(request({ prompt: 'explain networks' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: 1, method: 'initialize' });
    expect(sent[0].params.clientInfo.name).toBe('speedtest-ai');
    expect(deadline().error?.message).toMatch(/app-server did not initialize within 10s/);
    expect(s.handshakeDone).toBe(false);

    const events = readFixture('codex-app-server-stream.jsonl') as any[];
    const chunks = feed(events);

    expect(sent.map((m) => m.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    expect(sent[2]).toEqual({
      id: 2,
      method: 'thread/start',
      params: { cwd: '/tmp/probe', sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true },
    });
    expect(sent[3].params).toEqual({
      threadId: events[1].result.thread.id,
      input: [{ type: 'text', text: 'explain networks' }],
      effort: 'low',
    });
    expect(s.handshakeDone).toBe(true);
    expect(deadline().cancelled).toBe(true);

    expect(chunks[0]).toEqual({ kind: 'init', model: 'gpt-6.1-sol' });
    expect(chunks.filter((c) => c.kind === 'text')).toHaveLength(14);
    const completed = events.find((e) => e.method === 'item/completed' && e.params.item.type === 'agentMessage');
    // The completed item repeats the streamed text and must not be counted again.
    expect(textOf(chunks)).toBe(completed.params.item.text);
    expect(chunks.findIndex((c) => c.kind === 'activity')).toBeLessThan(chunks.findIndex((c) => c.kind === 'text'));

    const usage = events.find((e) => e.method === 'thread/tokenUsage/updated').params.tokenUsage.total;
    expect(chunks.at(-1)).toEqual({
      kind: 'terminal',
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningOutputTokens,
    });
  });

  it('reports the shell tool call of a tool loop and the thread-cumulative usage', () => {
    const { feed } = session(request({ phase: 'tool_loop', enableReadTool: true }));
    const chunks = feed(readFixture('codex-app-server-tool-loop.jsonl'));
    expect(chunks.filter((c) => c.kind === 'tool_call')).toEqual([{ kind: 'tool_call', toolName: 'shell' }]);
    expect(chunks.filter((c) => c.kind === 'tool_result')).toHaveLength(1);
    expect(textOf(chunks)).toBe('PROBE-66A1255B');
    // Two model requests: `total` (28878) is the sum, `last` (14472) only the second one.
    expect(chunks.at(-1)).toMatchObject({
      kind: 'terminal',
      inputTokens: 28878,
      cachedInputTokens: 26112,
      outputTokens: 47,
      reasoningTokens: 0,
    });
  });

  it('fails with the server message and kind "model" for an invalid model', () => {
    const { s, feed } = session(request({ model: 'definitely-not-a-model-xyz' }));
    const err = thrownBy(() => feed(readFixture('codex-app-server-invalid-model.jsonl')));
    expect(err.kind).toBe('model');
    expect(err.message).toBe(
      "codex: The 'definitely-not-a-model-xyz' model is not supported when using Codex with a ChatGPT account."
    );
    // The failure came after the handshake, so it is the model's answer, not a reason to fall back.
    expect(s.handshakeDone).toBe(true);
  });
});

describe('codex app-server session (protocol rules)', () => {
  const handshake = [
    { id: 1, result: {} },
    { id: 2, result: { thread: { id: 't1', model: 'gpt-x' } } },
    { id: 3, result: { turn: { id: 'u1', status: 'inProgress' } } },
  ];

  it('passes -m as the thread model and leaves effort alone when as-configured', () => {
    const { sent, feed } = session(request({ model: 'gpt-y', asConfigured: true }));
    feed(handshake);
    expect(sent[2].params.model).toBe('gpt-y');
    expect(sent[3].params).not.toHaveProperty('effort');
  });

  it('ignores a retryable error notification and fails on a final one', () => {
    const { feed } = session();
    feed(handshake);
    expect(
      feed([{ method: 'error', params: { error: { message: 'Reconnecting... 2/5' }, willRetry: true } }])
    ).toEqual([]);
    const err = thrownBy(() =>
      feed([
        {
          method: 'error',
          params: { error: { message: 'stream disconnected', additionalDetails: 'HTTP 502' }, willRetry: false },
        },
      ])
    );
    expect(err.message).toBe('codex: stream disconnected (HTTP 502)');
  });

  it('fails when the turn completes as failed or interrupted', () => {
    const failedTurn = session();
    failedTurn.feed(handshake);
    const err = thrownBy(() =>
      failedTurn.feed([
        { method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'usage limit reached' } } } },
      ])
    );
    expect(err.kind).toBe('rate_limit');

    const interrupted = session();
    interrupted.feed(handshake);
    expect(
      thrownBy(() =>
        interrupted.feed([{ method: 'turn/completed', params: { turn: { status: 'interrupted', error: null } } }])
      ).message
    ).toContain('interrupted');
  });

  it('answers server-initiated requests with an error so the turn cannot hang', () => {
    const { sent, feed } = session();
    feed(handshake);
    const before = sent.length;
    expect(feed([{ id: 77, method: 'item/commandExecution/requestApproval', params: {} }])).toEqual([]);
    expect(sent.slice(before)).toEqual([
      { id: 77, error: { code: -32601, message: 'not supported by speedtest-ai' } },
    ]);
  });

  it('reports a JSON-RPC error on thread/start as a handshake failure', () => {
    const { s, feed } = session();
    const err = thrownBy(() => feed([{ id: 1, result: {} }, { id: 2, error: { code: -32600, message: 'unknown field' } }]));
    expect(err.message).toBe('codex: app-server thread/start failed: unknown field');
    expect(s.handshakeDone).toBe(false);
  });

  it('maps reasoning deltas to thinking and counts a message that was never streamed', () => {
    const { feed } = session();
    feed(handshake);
    const chunks = feed([
      { method: 'item/started', params: { item: { type: 'reasoning', id: 'r1' } } },
      { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: 'Considering ' } },
      { method: 'item/reasoning/textDelta', params: { itemId: 'r1', delta: 'options' } },
      { method: 'item/started', params: { item: { type: 'mcpToolCall', id: 'm1', server: 'x', tool: 'lookup' } } },
      { method: 'item/completed', params: { item: { type: 'mcpToolCall', id: 'm1' } } },
      { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'whole answer' } } },
      { method: 'model/rerouted', params: { fromModel: 'gpt-x', toModel: 'gpt-x-mini' } },
      { method: 'mcpServer/startupStatus/updated', params: { name: 'x', status: 'ready' } },
      { method: 'turn/completed', params: { turn: { status: 'completed', error: null } } },
    ]);
    expect(kindsOf(chunks)).toEqual([
      'activity',
      'thinking',
      'thinking',
      'tool_call',
      'tool_result',
      'text',
      'meta',
      'terminal',
    ]);
    expect(chunks[3]!.toolName).toBe('lookup');
    expect(textOf(chunks)).toBe('whole answer');
    expect(chunks[6]!.model).toBe('gpt-x-mini');
  });
});

describe('codex config and arguments', () => {
  const toml = [
    'model = "gpt-configured"',
    'approval_policy = "never"',
    '',
    '[plugins."documents@openai"]',
    'enabled = true',
    '[mcp_servers.node_repl]',
    'command = "node"',
    '[mcp_servers.node_repl.env]',
    'model = "not-this-one"',
    '[mcp_servers.cua-driver]',
    '[mcp_servers."quoted name"]',
    '[features]',
  ].join('\n');

  it('reads MCP server names and the top-level model from config.toml', () => {
    expect(parseCodexConfig(toml)).toEqual({ mcpServers: ['node_repl', 'cua-driver'], model: 'gpt-configured' });
    expect(parseCodexConfig('[features]\nmodel = "x"\n')).toEqual({ mcpServers: [], model: undefined });
  });

  it('lean flags switch off plugins, apps, hooks, memories and each user MCP server', () => {
    const flags = codexLeanFlags(parseCodexConfig(toml));
    expect(flags).toEqual([
      '--disable', 'plugins', '--disable', 'apps', '--disable', 'hooks', '--disable', 'memories',
      '-c', 'mcp_servers.node_repl.enabled=false',
      '-c', 'mcp_servers.cua-driver.enabled=false',
    ]);
    expect(buildCodexAppServerArgs(request(), parseCodexConfig(toml))).toEqual(['app-server', ...flags]);
    expect(buildCodexAppServerArgs(request({ asConfigured: true }), parseCodexConfig(toml))).toEqual(['app-server']);
  });

  it('exec arguments keep the user config and end with the prompt', () => {
    const args = buildCodexExecArgs(request({ prompt: '--looks-like-a-flag', model: 'gpt-y' }), '/tmp/x', NO_CONFIG);
    expect(args.slice(0, 8)).toEqual(['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', '/tmp/x']);
    expect(args).not.toContain('--ignore-user-config');
    expect(args.slice(-4)).toEqual(['-m', 'gpt-y', '--', '--looks-like-a-flag']);
    expect(args).toContain('model_reasoning_effort="low"');

    const asConfigured = buildCodexExecArgs(request({ asConfigured: true }), '/tmp/x', NO_CONFIG);
    expect(asConfigured).not.toContain('--disable');
    expect(asConfigured).not.toContain('model_reasoning_effort="low"');
  });
});

describe('codex exec parser', () => {
  it('maps the whole-message output of a real run and ends on turn.completed', () => {
    const parse = createCodexExecParser();
    const chunks = readFixture('codex-exec.jsonl').flatMap((event) => parse(event));
    expect(kindsOf(chunks)).toEqual(['init', 'text', 'terminal']);
    expect(textOf(chunks)).toMatch(/^1\. Packet-switched networks/);
    expect(chunks.at(-1)).toEqual({
      kind: 'terminal',
      inputTokens: 14459,
      cachedInputTokens: 11904,
      outputTokens: 823,
      reasoningTokens: 0,
    });
  });

  it('fails on turn.failed with the real invalid-model message', () => {
    const parse = createCodexExecParser();
    const err = thrownBy(() => readFixture('codex-exec-invalid-model.jsonl').flatMap((event) => parse(event)));
    expect(err.kind).toBe('model');
    expect(err.message).toContain("The 'definitely-not-a-model-xyz' model is not supported");
  });

  it('does not fail on retry notices, which arrive as plain error events', () => {
    const parse = createCodexExecParser();
    const chunks = [
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.started' },
      { type: 'error', message: 'Reconnecting... 2/5 (workspace routing discovery failed)' },
      { type: 'item.completed', item: { type: 'error', message: 'Falling back from WebSockets to HTTPS transport.' } },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'cat probe.txt' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', exit_code: 0 } },
      { type: 'item.completed', item: { id: 'i2', type: 'reasoning', text: 'thinking it over' } },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 9, reasoning_output_tokens: 5 } },
    ].flatMap((event) => parse(event));
    expect(kindsOf(chunks)).toEqual(['init', 'tool_call', 'tool_result', 'thinking', 'text', 'terminal']);
    expect(chunks.at(-1)).toMatchObject({ outputTokens: 9, reasoningTokens: 5 });
    expect(parse.lastErrorMessage()).toBe('Reconnecting... 2/5 (workspace routing discovery failed)');
  });
});

describe('codex adapter (replayed process)', () => {
  let cli: ReplayCli;
  beforeAll(() => {
    cli = createReplayCli();
  });
  beforeEach(() => cli.reset());
  afterAll(() => {
    killAllChildren({ force: true });
    cli.remove();
  });

  const adapter = (options: Parameters<typeof createCodexAdapter>[1] = {}) =>
    createCodexAdapter(cli.bin, { readConfig: () => ({ mcpServers: ['node_repl'] }), ...options });

  const allGone = async () => {
    await settleChildren();
    for (const pid of cli.pids()) {
      expect(await waitUntil(() => !isAlive(pid), 3000)).toBe(true);
    }
  };

  it('streams through the app-server and kills it at turn/completed', async () => {
    cli.setScenario({ appServer: { mode: 'rpc', file: fixturePath('codex-app-server-stream.jsonl') } });
    const { chunks, error, elapsedMs } = await drain(adapter().stream(request({ prompt: 'explain' })));

    expect(error).toBeUndefined();
    expect(kindsOf(chunks).slice(0, 3)).toEqual(['start', 'meta', 'init']);
    expect(chunks.find((c) => c.kind === 'init')!.model).toBe('gpt-6.1-sol');
    expect(chunks.filter((c) => c.kind === 'text')).toHaveLength(14);
    expect(chunks.at(-1)!.kind).toBe('terminal');
    expect(chunks.some((c) => c.buffered)).toBe(false);
    expect(chunks.filter((c) => c.kind === 'start')).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(3000);

    expect(cli.invocations()).toEqual([
      ['app-server', '--disable', 'plugins', '--disable', 'apps', '--disable', 'hooks', '--disable', 'memories', '-c', 'mcp_servers.node_repl.enabled=false'],
    ]);
    const received = cli.received();
    expect(received.map((m) => m.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    expect(received[3].params.input).toEqual([{ type: 'text', text: 'explain' }]);
    await allGone();
  });

  it('falls back to exec when the app-server does not initialize, marks the result buffered, and remembers it', async () => {
    cli.setScenario({
      appServer: { mode: 'silent' },
      exec: { mode: 'replay', file: fixturePath('codex-exec.jsonl') },
    });
    const codex = adapter({ handshakeTimeoutMs: 300 });
    const first = await drain(codex.stream(request()));

    expect(first.error).toBeUndefined();
    expect(first.elapsedMs).toBeGreaterThanOrEqual(280);
    expect(first.elapsedMs).toBeLessThan(4000);
    // The clock restarts with the second spawn.
    expect(first.chunks.filter((c) => c.kind === 'start')).toHaveLength(2);
    const afterRestart = first.chunks.slice(first.chunks.map((c) => c.kind).lastIndexOf('start') + 1);
    // The harness's own ready marker comes first, then the buffered flag and the caveat.
    expect(afterRestart[0]).toEqual({ kind: 'meta' });
    expect(afterRestart[1]).toMatchObject({ kind: 'meta', buffered: true });
    expect(afterRestart[2]!.kind).toBe('note');
    expect(afterRestart[2]!.text).toMatch(/app-server unavailable \(app-server did not initialize within 0\.3s\); used codex exec/);
    expect(textOf(first.chunks)).toMatch(/^1\. Packet-switched/);
    expect(first.chunks.at(-1)).toMatchObject({ kind: 'terminal', outputTokens: 823 });
    expect(cli.invocations().map((argv) => argv[0])).toEqual(['app-server', 'exec']);
    expect(cli.invocations()[1]).toEqual(expect.arrayContaining(['--disable', 'plugins', '--', 'Say hi.']));

    cli.reset();
    const second = await drain(codex.stream(request()));
    expect(second.error).toBeUndefined();
    expect(second.elapsedMs).toBeLessThan(first.elapsedMs + 200);
    expect(cli.invocations().map((argv) => argv[0])).toEqual(['exec']);
    expect(second.chunks.some((c) => c.buffered)).toBe(true);
    await allGone();
  });

  it('falls back when the binary has no app-server subcommand', async () => {
    cli.setScenario({
      appServer: { mode: 'exit', exit: 2, stderr: "error: unrecognized subcommand 'app-server'\n" },
      exec: { mode: 'replay', file: fixturePath('codex-exec.jsonl') },
    });
    const { chunks, error } = await drain(adapter().stream(request()));
    expect(error).toBeUndefined();
    expect(chunks.find((c) => c.kind === 'note')!.text).toContain("unrecognized subcommand 'app-server'");
    expect(chunks.at(-1)!.kind).toBe('terminal');
  });

  it('falls back when thread/start is rejected', async () => {
    cli.setScenario({
      appServer: { mode: 'rpc', file: fixturePath('codex-app-server-stream.jsonl'), errorOnId: 2 },
      exec: { mode: 'replay', file: fixturePath('codex-exec.jsonl') },
    });
    const { chunks, error } = await drain(adapter().stream(request()));
    expect(error).toBeUndefined();
    expect(chunks.find((c) => c.kind === 'note')!.text).toContain('thread/start failed: rejected by fake server');
    expect(cli.invocations().map((argv) => argv[0])).toEqual(['app-server', 'exec']);
  });

  it('does not fall back when the turn itself fails', async () => {
    cli.setScenario({
      appServer: { mode: 'rpc', file: fixturePath('codex-app-server-invalid-model.jsonl') },
      exec: { mode: 'replay', file: fixturePath('codex-exec.jsonl') },
    });
    const { chunks, error } = await drain(adapter().stream(request({ model: 'definitely-not-a-model-xyz' })));
    expect(isTargetFailedError(error)).toBe(true);
    expect((error as TargetFailedError).kind).toBe('model');
    expect(chunks.some((c) => c.kind === 'terminal')).toBe(false);
    expect(cli.invocations().map((argv) => argv[0])).toEqual(['app-server']);
    expect(cli.received()[2].params.model).toBe('definitely-not-a-model-xyz');
    await allGone();
  });

  it('does not fall back on a user interrupt', async () => {
    cli.setScenario({
      appServer: { mode: 'silent' },
      exec: { mode: 'replay', file: fixturePath('codex-exec.jsonl') },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new InterruptedError()), 800);
    const { error } = await drain(adapter().stream(request({ signal: controller.signal })));
    expect(isInterruptedError(error)).toBe(true);
    expect(cli.invocations().map((argv) => argv[0])).toEqual(['app-server']);
    await allGone();
  });

  it('exec route: reports the last error event when the run dies without turn.failed', async () => {
    cli.setScenario({
      exec: { mode: 'replay', file: fixturePath('codex-exec-invalid-model.jsonl'), exit: 1 },
    });
    const viaTurnFailed = await drain(adapter({ forceExec: true }).stream(request()));
    expect((viaTurnFailed.error as TargetFailedError).kind).toBe('model');

    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-codex-'));
    const file = path.join(dir, 'no-turn-failed.jsonl');
    fs.writeFileSync(
      file,
      [
        { type: 'thread.started', thread_id: 't' },
        { type: 'error', message: 'Reconnecting... 1/5' },
        { type: 'error', message: 'workspace routing discovery failed' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n')
    );
    try {
      cli.setScenario({ exec: { mode: 'replay', file, exit: 1, stderr: 'some unrelated log line\n' } });
      const { error } = await drain(adapter({ forceExec: true }).stream(request()));
      expect(isTargetFailedError(error)).toBe(true);
      expect((error as Error).message).toBe('codex: workspace routing discovery failed');
      expect((error as TargetFailedError).exitCode).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a verified harness with a tool loop', () => {
    expect(adapter()).toMatchObject({ id: 'codex', category: 'harness', tier: 'verified', supportsToolLoop: true });
  });
});
