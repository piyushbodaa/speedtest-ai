import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';
import { asCount, asRecord, asText, cliFailure, sumCounts, withNotes } from './shared-json-parser.js';

export const GROK_LEAN_NOTE =
  'grok: lean mode runs with --reasoning-effort low; its skills and MCP servers cannot be switched off';

/**
 * Parser for `grok -p --output-format streaming-messages-json --include-partial-messages`
 * (Claude-compatible events). Terminal event: `{"type":"result","is_error":false,...}`.
 *
 * Usage is taken from the `result` event only: `message_delta` usage is per turn, the result is
 * cumulative over all turns.
 */
export function createGrokEventParser(): (ev: unknown) => AdapterStreamChunk[] {
  let sawText = false;
  let sawDeltaInMessage = false;

  return (raw: unknown): AdapterStreamChunk[] => {
    const ev = asRecord(raw);
    if (!ev) return [];

    if (ev.type === 'system' && ev.subtype === 'init') {
      return [{ kind: 'init', model: asText(ev.model) }];
    }

    if (ev.type === 'stream_event') {
      const inner = asRecord(ev.event);
      if (!inner) return [];

      if (inner.type === 'message_start') {
        sawDeltaInMessage = false;
        return [{ kind: 'activity', model: asText(asRecord(inner.message)?.model) }];
      }
      if (inner.type === 'content_block_delta') {
        const delta = asRecord(inner.delta);
        const text = delta?.type === 'text_delta' ? asText(delta.text) : undefined;
        if (text) {
          sawText = true;
          sawDeltaInMessage = true;
          return [{ kind: 'text', text }];
        }
        const thinking = delta?.type === 'thinking_delta' ? asText(delta.thinking) : undefined;
        if (thinking) {
          sawDeltaInMessage = true;
          return [{ kind: 'thinking', text: thinking }];
        }
        return [];
      }
      if (inner.type === 'content_block_start') {
        const block = asRecord(inner.content_block);
        if (block?.type === 'tool_use') {
          sawDeltaInMessage = true;
          return [{ kind: 'tool_call', toolName: asText(block.name) ?? 'tool' }];
        }
      }
      return [];
    }

    if (ev.type === 'assistant') {
      // The summary repeats what the deltas already delivered; use it only when nothing streamed.
      const chunks: AdapterStreamChunk[] = [];
      const content = asRecord(ev.message)?.content;
      if (!sawDeltaInMessage && Array.isArray(content)) {
        for (const item of content) {
          const block = asRecord(item);
          if (block?.type === 'text' && asText(block.text)) {
            sawText = true;
            chunks.push({ kind: 'text', text: block.text as string });
          } else if (block?.type === 'thinking' && asText(block.thinking)) {
            chunks.push({ kind: 'thinking', text: block.thinking as string });
          } else if (block?.type === 'tool_use') {
            chunks.push({ kind: 'tool_call', toolName: asText(block.name) ?? 'tool' });
          }
        }
      }
      sawDeltaInMessage = false;
      return chunks;
    }

    if (ev.type === 'user') {
      const content = asRecord(ev.message)?.content;
      if (Array.isArray(content) && content.some((item) => asRecord(item)?.type === 'tool_result')) {
        return [{ kind: 'tool_result' }];
      }
      return [];
    }

    if (ev.type === 'result') {
      if (ev.is_error === true) {
        const errors = Array.isArray(ev.errors)
          ? ev.errors.filter((e): e is string => typeof e === 'string' && e.length > 0)
          : [];
        throw cliFailure(
          'grok',
          errors.length > 0 ? errors.join('; ') : asText(ev.result),
          `run failed (${asText(ev.subtype) ?? 'error'})`
        );
      }

      const chunks: AdapterStreamChunk[] = [];
      const finalText = asText(ev.result);
      if (!sawText && finalText) {
        sawText = true;
        chunks.push({ kind: 'text', text: finalText });
      }
      const usage = asRecord(ev.usage);
      chunks.push({
        kind: 'terminal',
        inputTokens: sumCounts(
          usage?.input_tokens,
          usage?.cache_read_input_tokens,
          usage?.cache_creation_input_tokens
        ),
        cachedInputTokens: asCount(usage?.cache_read_input_tokens),
        outputTokens: asCount(usage?.output_tokens),
        apiDurationMs: asCount(ev.duration_api_ms),
        costUsd: asCount(ev.total_cost_usd),
      });
      return chunks;
    }

    return [];
  };
}

export function buildGrokArgs(req: AdapterInvokeRequest): string[] {
  const args = [
    '-p',
    req.prompt,
    '--output-format',
    'streaming-messages-json',
    '--include-partial-messages',
  ];
  if (!req.asConfigured) {
    args.push('--no-plan', '--no-subagents', '--reasoning-effort', 'low', '--disable-web-search');
    // `--tools ''` means "no filter"; only a non-empty allow-list narrows the tool set.
    if (req.enableReadTool) args.push('--tools', 'read_file,list_dir');
    else args.push('--tools', 'read_file', '--max-turns', '1');
  }
  if (req.enableReadTool) args.push('--permission-mode', 'bypassPermissions');
  if (req.model && req.model !== 'default') args.push('-m', req.model);
  return args;
}

export function createGrokAdapter(binaryPath = 'grok'): SpeedtestAdapter {
  return {
    id: 'grok',
    name: 'Grok CLI',
    category: 'harness',
    tier: 'verified',
    supportsToolLoop: true,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      yield* withNotes(
        runNdjsonHarness({
          binaryPath,
          label: 'grok',
          req,
          createParser: createGrokEventParser,
          buildArgs: () => buildGrokArgs(req),
        }),
        req.asConfigured ? [] : [GROK_LEAN_NOTE]
      );
    },
  };
}
