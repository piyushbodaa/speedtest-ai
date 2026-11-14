import { classifyFailureKind, isAbortError, isTargetFailedError, TargetFailedError } from '../../core/errors.js';
import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import {
  buildCodexAppServerArgs,
  type CodexUserConfig,
  codexLeanFlags,
  createCodexAppServerSession,
  readCodexUserConfig,
} from './codex-app-server.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';

type Json = Record<string, any>;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const EXEC_TOOL_ITEM_TYPES = new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change']);

export interface CodexExecParser {
  (event: unknown): AdapterStreamChunk[];
  /** The most recent `error` event. Retry notices use the same event, so it is fatal only if the run then fails. */
  lastErrorMessage(): string | undefined;
}

/**
 * Parser for `codex exec --json`. This route delivers each message whole (no deltas), so results
 * from it are always buffered. Terminal event: `turn.completed`.
 */
export function createCodexExecParser(): CodexExecParser {
  let lastError: string | undefined;

  const parse = (raw: unknown): AdapterStreamChunk[] => {
    if (!raw || typeof raw !== 'object') return [];
    const ev = raw as Json;

    if (ev.type === 'thread.started') return [{ kind: 'init' }];

    if (ev.type === 'error') {
      if (typeof ev.message === 'string' && ev.message.trim()) lastError = ev.message.trim();
      return [];
    }

    if (ev.type === 'turn.failed') {
      const message =
        typeof ev.error?.message === 'string' && ev.error.message.trim()
          ? ev.error.message.trim()
          : (lastError ?? 'the turn failed');
      throw new TargetFailedError(`codex: ${message}`, { kind: classifyFailureKind(message) });
    }

    if ((ev.type === 'item.started' || ev.type === 'item.completed') && ev.item && typeof ev.item === 'object') {
      const item = ev.item as Json;
      if (EXEC_TOOL_ITEM_TYPES.has(item.type)) {
        if (ev.type === 'item.completed') return [{ kind: 'tool_result' }];
        return [{ kind: 'tool_call', toolName: item.type === 'command_execution' ? 'shell' : String(item.type) }];
      }
      if (ev.type === 'item.completed' && typeof item.text === 'string' && item.text.length > 0) {
        if (item.type === 'agent_message') return [{ kind: 'text', text: item.text }];
        if (item.type === 'reasoning') return [{ kind: 'thinking', text: item.text }];
      }
      return [];
    }

    if (ev.type === 'turn.completed') {
      const usage = (ev.usage ?? {}) as Json;
      return [
        {
          kind: 'terminal',
          inputTokens: num(usage.input_tokens),
          cachedInputTokens: num(usage.cached_input_tokens),
          outputTokens: num(usage.output_tokens),
          reasoningTokens: num(usage.reasoning_output_tokens),
        },
      ];
    }

    return [];
  };

  return Object.assign(parse, { lastErrorMessage: () => lastError });
}

export function buildCodexExecArgs(
  req: AdapterInvokeRequest,
  cwd: string,
  config: CodexUserConfig
): string[] {
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', cwd];
  if (!req.asConfigured) {
    args.push(...codexLeanFlags(config), '-c', 'model_reasoning_effort="low"');
  }
  if (req.model && req.model !== 'default') {
    args.push('-m', req.model);
  }
  args.push('--', req.prompt);
  return args;
}

export interface CodexAdapterOptions {
  /** Overrides the 10 s the app-server gets to complete its handshake. */
  handshakeTimeoutMs?: number;
  /** Skip the app-server and always use `codex exec` (buffered). */
  forceExec?: boolean;
  /** Replaces reading $CODEX_HOME/config.toml. */
  readConfig?: () => CodexUserConfig;
}

export function createCodexAdapter(binaryPath = 'codex', options: CodexAdapterOptions = {}): SpeedtestAdapter {
  const readConfig = options.readConfig ?? (() => readCodexUserConfig());
  // Once the app-server failed to come up, later phases skip the wait and go straight to exec.
  let appServerUnavailable: string | undefined = options.forceExec ? 'disabled' : undefined;

  async function* viaAppServer(
    req: AdapterInvokeRequest,
    config: CodexUserConfig,
    onSession: (session: { handshakeDone: boolean }) => void
  ): AsyncGenerator<AdapterStreamChunk, void, unknown> {
    yield* runNdjsonHarness({
      binaryPath,
      label: 'codex',
      req,
      stdin: 'pipe',
      buildArgs: () => buildCodexAppServerArgs(req, config),
      createParser: (io, cwd) => {
        const session = createCodexAppServerSession({
          io,
          req,
          cwd,
          handshakeTimeoutMs: options.handshakeTimeoutMs,
        });
        onSession(session);
        session.start();
        return session.parse;
      },
    });
  }

  async function* viaExec(
    req: AdapterInvokeRequest,
    config: CodexUserConfig,
    reason: string
  ): AsyncGenerator<AdapterStreamChunk, void, unknown> {
    let parser: CodexExecParser | undefined;
    let announced = false;
    try {
      for await (const chunk of runNdjsonHarness({
        binaryPath,
        label: 'codex',
        req,
        buildArgs: (cwd) => buildCodexExecArgs(req, cwd, config),
        createParser: () => (parser = createCodexExecParser()),
      })) {
        yield chunk;
        // Not right after `start`: the first chunk after it is what the runner times as "CLI ready".
        if (!announced && chunk.kind !== 'start') {
          announced = true;
          yield {
            kind: 'meta',
            buffered: true,
            model: req.model && req.model !== 'default' ? req.model : config.model,
          };
          yield {
            kind: 'note',
            text:
              reason === 'disabled'
                ? 'codex exec does not stream: no TTFT, rate is end-to-end'
                : `codex app-server unavailable (${reason}); used codex exec, which does not stream`,
          };
        }
      }
    } catch (err) {
      const lastError = parser?.lastErrorMessage();
      // exec reports its fatal error as a plain `error` event; without `turn.failed` after it the
      // harness only knows that the final event is missing.
      if (lastError && isTargetFailedError(err) && !req.signal.aborted && !err.message.includes(lastError)) {
        throw new TargetFailedError(`codex: ${lastError}`, {
          kind: classifyFailureKind(lastError),
          exitCode: err.exitCode,
          stderrTail: err.stderrTail,
          cause: err,
        });
      }
      throw err;
    }
  }

  return {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    category: 'harness',
    tier: 'verified',
    supportsToolLoop: true,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      const config = req.asConfigured ? { ...readConfig(), mcpServers: [] } : readConfig();

      if (appServerUnavailable === undefined) {
        let session: { handshakeDone: boolean } | undefined;
        try {
          yield* viaAppServer(req, config, (s) => (session = s));
          return;
        } catch (err) {
          if (req.signal.aborted || isAbortError(err) || session?.handshakeDone) throw err;
          const message = err instanceof Error ? err.message : String(err);
          appServerUnavailable = message.replace(/^codex:\s*/, '').slice(0, 160);
        }
      }
      yield* viaExec(req, config, appServerUnavailable);
    },
  };
}
