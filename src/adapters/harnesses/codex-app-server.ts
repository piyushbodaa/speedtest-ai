import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyFailureKind, TargetFailedError } from '../../core/errors.js';
import type { AdapterInvokeRequest, AdapterStreamChunk } from '../../types.js';
import type { HarnessIo } from './run-ndjson-harness.js';

type Json = Record<string, any>;

/** `codex app-server` is marked experimental upstream; past this the adapter falls back to `codex exec`. */
export const APP_SERVER_HANDSHAKE_TIMEOUT_MS = 10_000;

const CLIENT_INFO = { name: 'speedtest-ai', title: 'speedtest-ai', version: '0.7.0' };

const REQUEST_ID = { initialize: 1, threadStart: 2, turnStart: 3 } as const;

/** Items whose start means the agent is using a tool. */
const TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'fileChange',
  'webSearch',
  'collabAgentToolCall',
]);

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export interface CodexUserConfig {
  /** Names from the `[mcp_servers.<name>]` tables of config.toml. */
  mcpServers: string[];
  /** The top-level `model` key, when set. */
  model?: string;
}

/**
 * Reads the two things the adapter needs from config.toml without a TOML parser: table headers
 * and the top-level `model` key. Servers with a quoted name are left out because the name cannot
 * be passed safely through a `-c` key path; such a server simply stays enabled.
 */
export function parseCodexConfig(toml: string): CodexUserConfig {
  const servers = new Set<string>();
  let model: string | undefined;
  let inTopLevel = true;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inTopLevel = false;
      const match = /^\[\s*mcp_servers\s*\.\s*([A-Za-z0-9_-]+)\s*[.\]]/.exec(line);
      if (match) servers.add(match[1]!);
      continue;
    }
    if (inTopLevel && model === undefined) {
      const match = /^model\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
      if (match) model = match[1] ?? match[2];
    }
  }
  return { mcpServers: [...servers], model: model || undefined };
}

export function readCodexUserConfig(env: NodeJS.ProcessEnv = process.env): CodexUserConfig {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    return parseCodexConfig(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  } catch {
    return { mcpServers: [] };
  }
}

/**
 * Lean isolation shared by both routes: the user's config (model, provider, auth) stays loaded,
 * while plugins, the built-in apps MCP, hooks, memories and the user's own MCP servers are off.
 * `-c mcp_servers={}` does not work for the last part (the override merges into the table).
 */
export function codexLeanFlags(config: CodexUserConfig): string[] {
  const flags = ['--disable', 'plugins', '--disable', 'apps', '--disable', 'hooks', '--disable', 'memories'];
  for (const name of config.mcpServers) {
    flags.push('-c', `mcp_servers.${name}.enabled=false`);
  }
  return flags;
}

export function buildCodexAppServerArgs(req: AdapterInvokeRequest, config: CodexUserConfig): string[] {
  return ['app-server', ...(req.asConfigured ? [] : codexLeanFlags(config))];
}

function usageFields(breakdown: unknown): Partial<AdapterStreamChunk> {
  if (!breakdown || typeof breakdown !== 'object') return {};
  const usage = breakdown as Json;
  return {
    inputTokens: num(usage.inputTokens),
    cachedInputTokens: num(usage.cachedInputTokens),
    outputTokens: num(usage.outputTokens),
    reasoningTokens: num(usage.reasoningOutputTokens),
  };
}

function errorText(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const e = error as Json;
    const message = typeof e.message === 'string' && e.message.trim() ? e.message.trim() : fallback;
    const details = typeof e.additionalDetails === 'string' ? e.additionalDetails.trim() : '';
    return details && !message.includes(details) ? `${message} (${details})` : message;
  }
  return typeof error === 'string' && error.trim() ? error.trim() : fallback;
}

function failed(message: string): TargetFailedError {
  return new TargetFailedError(`codex: ${message}`, { kind: classifyFailureKind(message) });
}

export interface CodexAppServerSession {
  /** Writes `initialize`; call once the process is spawned. */
  start(): void;
  parse(event: unknown): AdapterStreamChunk[];
  /** True once `thread/start` succeeded. A failure before that is an app-server problem, not a model one. */
  readonly handshakeDone: boolean;
}

/**
 * Client side of the `codex app-server` stdio protocol (newline-delimited JSON-RPC without the
 * `jsonrpc` field): initialize, initialized, thread/start, turn/start, then notifications until
 * `turn/completed`. The server never exits by itself; the harness kills it at the terminal chunk.
 */
export function createCodexAppServerSession(options: {
  io: Pick<HarnessIo, 'send' | 'setDeadline'>;
  req: AdapterInvokeRequest;
  cwd: string;
  handshakeTimeoutMs?: number;
}): CodexAppServerSession {
  const { io, req, cwd } = options;
  const timeoutMs = options.handshakeTimeoutMs ?? APP_SERVER_HANDSHAKE_TIMEOUT_MS;

  let handshakeDone = false;
  let cancelDeadline: (() => void) | undefined;
  let usage: Partial<AdapterStreamChunk> = {};
  /** Characters already delivered as deltas, per agent message item. */
  const streamedChars = new Map<string, number>();

  const onResponse = (msg: Json): AdapterStreamChunk[] => {
    if (msg.error) {
      const step =
        msg.id === REQUEST_ID.initialize
          ? 'initialize'
          : msg.id === REQUEST_ID.threadStart
            ? 'thread/start'
            : 'turn/start';
      throw failed(`app-server ${step} failed: ${errorText(msg.error, 'unknown error')}`);
    }
    if (msg.id === REQUEST_ID.initialize) {
      io.send({ method: 'initialized' });
      io.send({
        id: REQUEST_ID.threadStart,
        method: 'thread/start',
        params: {
          cwd,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          ephemeral: true,
          ...(req.model && req.model !== 'default' ? { model: req.model } : {}),
        },
      });
      return [];
    }
    if (msg.id === REQUEST_ID.threadStart) {
      const thread = msg.result?.thread as Json | undefined;
      if (!thread || typeof thread.id !== 'string') {
        throw failed('app-server thread/start returned no thread id');
      }
      handshakeDone = true;
      cancelDeadline?.();
      io.send({
        id: REQUEST_ID.turnStart,
        method: 'turn/start',
        params: {
          threadId: thread.id,
          input: [{ type: 'text', text: req.prompt }],
          ...(req.asConfigured ? {} : { effort: 'low' }),
        },
      });
      return [{ kind: 'init', model: typeof thread.model === 'string' ? thread.model : undefined }];
    }
    return [];
  };

  const onNotification = (method: string, params: Json): AdapterStreamChunk[] => {
    switch (method) {
      case 'item/agentMessage/delta': {
        if (typeof params.delta !== 'string' || params.delta.length === 0) return [];
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        streamedChars.set(itemId, (streamedChars.get(itemId) ?? 0) + params.delta.length);
        return [{ kind: 'text', text: params.delta }];
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        return typeof params.delta === 'string' && params.delta.length > 0
          ? [{ kind: 'thinking', text: params.delta }]
          : [{ kind: 'activity' }];
      case 'item/started': {
        const item = (params.item ?? {}) as Json;
        if (TOOL_ITEM_TYPES.has(item.type)) {
          const toolName =
            item.type === 'mcpToolCall' || item.type === 'dynamicToolCall'
              ? String(item.tool ?? item.type)
              : item.type === 'commandExecution'
                ? 'shell'
                : String(item.type);
          return [{ kind: 'tool_call', toolName }];
        }
        // Reasoning is usually hidden, so the item itself is the first sign of model output.
        if (item.type === 'reasoning' || item.type === 'agentMessage') return [{ kind: 'activity' }];
        return [];
      }
      case 'item/completed': {
        const item = (params.item ?? {}) as Json;
        if (TOOL_ITEM_TYPES.has(item.type)) return [{ kind: 'tool_result' }];
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          const already = streamedChars.get(typeof item.id === 'string' ? item.id : '') ?? 0;
          // A message that was never streamed still has to count as visible text.
          if (already === 0 && item.text.length > 0) return [{ kind: 'text', text: item.text }];
        }
        return [];
      }
      case 'thread/tokenUsage/updated': {
        // `total` covers every model request of the thread; `last` only the most recent one.
        usage = usageFields(params.tokenUsage?.total ?? params.tokenUsage?.last);
        return [{ kind: 'usage', ...usage }];
      }
      case 'model/rerouted':
        return typeof params.toModel === 'string' ? [{ kind: 'meta', model: params.toModel }] : [];
      case 'error':
        if (params.willRetry === false) throw failed(errorText(params.error, 'the turn failed'));
        return [];
      case 'turn/completed': {
        const turn = (params.turn ?? {}) as Json;
        if (turn.status === 'failed' || turn.status === 'interrupted') {
          throw failed(errorText(turn.error, `the turn was ${turn.status}`));
        }
        return [{ kind: 'terminal', ...usage }];
      }
      default:
        return [];
    }
  };

  return {
    start() {
      cancelDeadline = io.setDeadline(
        timeoutMs,
        () =>
          new TargetFailedError(
            `codex: app-server did not initialize within ${Math.round(timeoutMs / 100) / 10}s`
          )
      );
      io.send({ id: REQUEST_ID.initialize, method: 'initialize', params: { clientInfo: CLIENT_INFO } });
    },
    parse(raw: unknown): AdapterStreamChunk[] {
      if (!raw || typeof raw !== 'object') return [];
      const msg = raw as Json;
      const hasId = msg.id !== undefined && msg.id !== null;
      if (typeof msg.method === 'string') {
        if (hasId) {
          // A server-initiated request (approval, elicitation, token refresh) would block the
          // turn forever if left unanswered.
          io.send({ id: msg.id, error: { code: -32601, message: 'not supported by speedtest-ai' } });
          return [];
        }
        return onNotification(msg.method, (msg.params ?? {}) as Json);
      }
      return hasId ? onResponse(msg) : [];
    },
    get handshakeDone() {
      return handshakeDone;
    },
  };
}
