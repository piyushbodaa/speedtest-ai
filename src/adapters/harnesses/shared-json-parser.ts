import type { AdapterStreamChunk } from '../../types.js';

/**
 * Shared flexible NDJSON event parser for agent harnesses (agy, grok, muse)
 * that emit Claude-compatible stream-json events, delta/content events, or final result summaries.
 * Tracks incremental text per turn to avoid double-counting when summary assistant messages arrive.
 */
export function createFlexibleHarnessParser(): (ev: unknown) => AdapterStreamChunk[] {
  let sawIncremental = false;
  let emittedAnyText = false;

  return (raw: unknown): AdapterStreamChunk[] => {
    if (!raw || typeof raw !== 'object') return [];
    const ev = raw as Record<string, any>;
    const chunks: AdapterStreamChunk[] = [];

    if (ev.type === 'system' && ev.subtype === 'init') {
      chunks.push({ kind: 'init', model: typeof ev.model === 'string' ? ev.model : undefined });
      return chunks;
    }

    if (ev.type === 'session.started' || ev.type === 'init') {
      chunks.push({ kind: 'init', model: typeof ev.model === 'string' ? ev.model : undefined });
      return chunks;
    }

    // Claude-compatible stream_event wrapper
    if (ev.type === 'stream_event' && ev.event && typeof ev.event === 'object') {
      const inner = ev.event as Record<string, any>;
      if (inner.type === 'content_block_delta' && inner.delta) {
        if (inner.delta.type === 'text_delta' && typeof inner.delta.text === 'string' && inner.delta.text) {
          sawIncremental = true;
          emittedAnyText = true;
          chunks.push({ kind: 'text', text: inner.delta.text });
        } else if (
          inner.delta.type === 'thinking_delta' &&
          typeof inner.delta.thinking === 'string' &&
          inner.delta.thinking
        ) {
          sawIncremental = true;
          emittedAnyText = true;
          chunks.push({ kind: 'thinking', text: inner.delta.thinking });
        }
      } else if (inner.type === 'content_block_start' && inner.content_block?.type === 'tool_use') {
        chunks.push({ kind: 'tool_call', toolName: inner.content_block.name || 'tool' });
      }
      return chunks;
    }

    // Direct delta / partial message formats
    if (
      ev.type === 'text_delta' ||
      ev.type === 'content_delta' ||
      ev.type === 'delta' ||
      ev.type === 'assistant_delta' ||
      ev.type === 'message.delta'
    ) {
      const text =
        typeof ev.text === 'string'
          ? ev.text
          : typeof ev.delta === 'string'
            ? ev.delta
            : typeof ev.content === 'string'
              ? ev.content
              : typeof ev.delta?.text === 'string'
                ? ev.delta.text
                : undefined;
      if (text) {
        sawIncremental = true;
        emittedAnyText = true;
        chunks.push({ kind: 'text', text });
      }
      const thinking =
        typeof ev.thinking === 'string'
          ? ev.thinking
          : typeof ev.delta?.thinking === 'string'
            ? ev.delta.thinking
            : undefined;
      if (thinking) {
        sawIncremental = true;
        emittedAnyText = true;
        chunks.push({ kind: 'thinking', text: thinking });
      }
      return chunks;
    }

    if (ev.type === 'thinking_delta' && typeof (ev.thinking ?? ev.text ?? ev.delta) === 'string') {
      const thinking = ev.thinking ?? ev.text ?? ev.delta;
      if (thinking) {
        sawIncremental = true;
        emittedAnyText = true;
        chunks.push({ kind: 'thinking', text: thinking });
      }
      return chunks;
    }

    if (ev.type === 'tool_use' || ev.type === 'tool_call' || ev.type === 'tool.started') {
      chunks.push({
        kind: 'tool_call',
        toolName: typeof ev.name === 'string' ? ev.name : typeof ev.tool === 'string' ? ev.tool : 'tool',
      });
      return chunks;
    }

    // Summary assistant message (only emit if incremental deltas were not seen)
    if (ev.type === 'assistant' || ev.type === 'message' || ev.type === 'assistant_message') {
      if (!sawIncremental) {
        const content = ev.message?.content ?? ev.content;
        if (typeof content === 'string' && content) {
          emittedAnyText = true;
          chunks.push({ kind: 'text', text: content });
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
              emittedAnyText = true;
              chunks.push({ kind: 'text', text: block.text });
            } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
              emittedAnyText = true;
              chunks.push({ kind: 'thinking', text: block.thinking });
            } else if (block?.type === 'tool_use') {
              chunks.push({ kind: 'tool_call', toolName: block.name || 'tool' });
            }
          }
        }
      }
      sawIncremental = false;
      return chunks;
    }

    // Usage / final result
    if (ev.type === 'result' || ev.type === 'usage' || ev.type === 'turn.completed' || ev.usage) {
      if (!emittedAnyText && typeof ev.result === 'string' && ev.result) {
        emittedAnyText = true;
        chunks.push({ kind: 'text', text: ev.result });
      }
      const u = ev.usage as Record<string, any> | undefined;
      if (u && typeof u === 'object') {
        const inputTokens =
          u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? u.promptTokens;
        const outputTokens =
          u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.completionTokens;
        const cachedInputTokens = u.cache_read_input_tokens ?? u.cached_input_tokens;
        chunks.push({
          kind: 'usage',
          model: typeof ev.model === 'string' ? ev.model : undefined,
          inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
          cachedInputTokens: typeof cachedInputTokens === 'number' ? cachedInputTokens : undefined,
          outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
          apiDurationMs: typeof ev.duration_api_ms === 'number' ? ev.duration_api_ms : undefined,
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
        });
      }
      return chunks;
    }

    return chunks;
  };
}
