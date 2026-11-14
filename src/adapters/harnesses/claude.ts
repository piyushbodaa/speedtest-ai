import { classifyFailureKind, TargetFailedError } from '../../core/errors.js';
import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';

type Json = Record<string, any>;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join(' ')
    .trim();
}

function fail(message: string, rateLimited: boolean): TargetFailedError {
  const classified = classifyFailureKind(message);
  return new TargetFailedError(`Claude Code: ${message}`, {
    kind: classified === 'other' && rateLimited ? 'rate_limit' : classified,
  });
}

/**
 * Parser for `claude -p --output-format stream-json --verbose --include-partial-messages`.
 * The terminal event is a non-error `result`; its usage is cumulative over every turn of the run.
 */
export function createClaudeEventParser(): (ev: unknown) => AdapterStreamChunk[] {
  // Messages announced by `message_start` deliver their content through stream deltas; the
  // `assistant` summary of the same message must not be counted a second time.
  const streamedMessageIds = new Set<string>();
  let emittedText = false;
  let rateLimited = false;

  return (raw: unknown): AdapterStreamChunk[] => {
    if (!raw || typeof raw !== 'object') return [];
    const ev = raw as Json;

    if (ev.type === 'system') {
      if (ev.subtype === 'init') {
        return [{ kind: 'init', model: typeof ev.model === 'string' ? ev.model : undefined }];
      }
      return [];
    }

    if (ev.type === 'stream_event' && ev.event && typeof ev.event === 'object') {
      const inner = ev.event as Json;

      if (inner.type === 'message_start') {
        const message = (inner.message ?? {}) as Json;
        if (typeof message.id === 'string') streamedMessageIds.add(message.id);
        // Hidden thinking arrives as empty deltas, so this is the only reliable sign that the
        // model has started answering.
        return [
          {
            kind: 'activity',
            model:
              typeof message.model === 'string' && message.model !== '<synthetic>'
                ? message.model
                : undefined,
          },
        ];
      }

      if (inner.type === 'content_block_start' && inner.content_block?.type === 'tool_use') {
        return [
          {
            kind: 'tool_call',
            toolName: typeof inner.content_block.name === 'string' ? inner.content_block.name : 'tool',
          },
        ];
      }

      if (inner.type === 'content_block_delta' && inner.delta && typeof inner.delta === 'object') {
        const delta = inner.delta as Json;
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          emittedText = true;
          return [{ kind: 'text', text: delta.text }];
        }
        if (delta.type === 'thinking_delta') {
          return typeof delta.thinking === 'string' && delta.thinking.length > 0
            ? [{ kind: 'thinking', text: delta.thinking }]
            : [{ kind: 'activity' }];
        }
      }
      return [];
    }

    if (ev.type === 'rate_limit_event') {
      // Only `status` gates the request; `overageStatus` is "rejected" on perfectly normal runs.
      if (ev.rate_limit_info?.status === 'rejected') rateLimited = true;
      return [];
    }

    if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
      const message = ev.message as Json;
      if (message.model === '<synthetic>') {
        throw fail(textOfBlocks(message.content) || 'the CLI returned an error instead of an answer', rateLimited);
      }
      if (typeof message.id === 'string' && streamedMessageIds.has(message.id)) return [];
      if (!Array.isArray(message.content)) return [];
      const chunks: AdapterStreamChunk[] = [];
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          emittedText = true;
          chunks.push({ kind: 'text', text: block.text });
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
          chunks.push({ kind: 'thinking', text: block.thinking });
        } else if (block?.type === 'tool_use') {
          chunks.push({ kind: 'tool_call', toolName: typeof block.name === 'string' ? block.name : 'tool' });
        }
      }
      return chunks;
    }

    if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      return ev.message.content.some((block: Json) => block?.type === 'tool_result')
        ? [{ kind: 'tool_result' }]
        : [];
    }

    if (ev.type === 'result') {
      if (ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success')) {
        const detail =
          typeof ev.result === 'string' && ev.result.trim()
            ? ev.result.trim()
            : Array.isArray(ev.errors) && ev.errors.length > 0
              ? ev.errors.map(String).join('; ')
              : `the run ended with "${ev.subtype ?? 'error'}"`;
        throw fail(detail, rateLimited);
      }

      const chunks: AdapterStreamChunk[] = [];
      if (!emittedText && typeof ev.result === 'string' && ev.result.length > 0) {
        chunks.push({ kind: 'text', text: ev.result });
      }

      const usage = (ev.usage ?? {}) as Json;
      const cacheRead = num(usage.cache_read_input_tokens);
      const inputParts = [num(usage.input_tokens), cacheRead, num(usage.cache_creation_input_tokens)];
      const hasInput = inputParts.some((part) => part !== undefined);
      chunks.push({
        kind: 'terminal',
        inputTokens: hasInput ? inputParts.reduce<number>((sum, part) => sum + (part ?? 0), 0) : undefined,
        cachedInputTokens: cacheRead,
        outputTokens: num(usage.output_tokens),
        reasoningTokens: num(usage.output_tokens_details?.thinking_tokens),
        apiDurationMs: num(ev.duration_api_ms),
        costUsd: num(ev.total_cost_usd),
      });
      return chunks;
    }

    return [];
  };
}

/**
 * Lean (default): `--safe-mode` keeps auth and the configured model but drops CLAUDE.md, skills,
 * plugins, hooks and MCP servers. `--bare` and `--setting-sources ""` are not usable here: the
 * first never reads OAuth credentials, the second discards the user's model setting.
 */
export function buildClaudeArgs(req: AdapterInvokeRequest): string[] {
  const args = [
    '-p',
    req.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
  ];
  if (!req.asConfigured) {
    args.push('--safe-mode', '--disable-slash-commands', '--effort', 'low');
  }
  if (req.enableReadTool) {
    args.push('--tools', 'Read', '--allowedTools', 'Read');
  } else {
    args.push('--tools', '');
  }
  if (req.model && req.model !== 'default') {
    args.push('--model', req.model);
  }
  return args;
}

export function createClaudeAdapter(binaryPath = 'claude'): SpeedtestAdapter {
  return {
    id: 'claude',
    name: 'Claude Code',
    category: 'harness',
    tier: 'verified',
    supportsToolLoop: true,
    stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      return runNdjsonHarness({
        binaryPath,
        label: 'claude',
        req,
        createParser: () => createClaudeEventParser(),
        buildArgs: () => buildClaudeArgs(req),
      });
    },
  };
}
