import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';

export function createClaudeEventParser(): (ev: unknown) => AdapterStreamChunk[] {
  let sawStreamDelta = false;

  return (raw: unknown): AdapterStreamChunk[] => {
    if (!raw || typeof raw !== 'object') return [];
    const ev = raw as Record<string, any>;
    const chunks: AdapterStreamChunk[] = [];

    if (ev.type === 'system' && ev.subtype === 'init') {
      chunks.push({
        kind: 'init',
        model: typeof ev.model === 'string' ? ev.model : undefined,
      });
      return chunks;
    }

    if (ev.type === 'stream_event' && ev.event && typeof ev.event === 'object') {
      const inner = ev.event as Record<string, any>;
      if (inner.type === 'content_block_delta' && inner.delta && typeof inner.delta === 'object') {
        if (inner.delta.type === 'text_delta' && typeof inner.delta.text === 'string' && inner.delta.text.length > 0) {
          sawStreamDelta = true;
          chunks.push({ kind: 'text', text: inner.delta.text });
        } else if (
          inner.delta.type === 'thinking_delta' &&
          typeof inner.delta.thinking === 'string' &&
          inner.delta.thinking.length > 0
        ) {
          sawStreamDelta = true;
          chunks.push({ kind: 'thinking', text: inner.delta.thinking });
        }
      } else if (
        inner.type === 'content_block_start' &&
        inner.content_block?.type === 'tool_use'
      ) {
        chunks.push({
          kind: 'tool_call',
          toolName: typeof inner.content_block.name === 'string' ? inner.content_block.name : 'tool',
        });
      }
      return chunks;
    }

    if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'rejected') {
      const resetsAt =
        typeof ev.rate_limit_info.resetsAt === 'number'
          ? `resets ${new Date(ev.rate_limit_info.resetsAt * 1000).toISOString().slice(11, 16)} UTC`
          : 'resets soon';
      const limitType = ev.rate_limit_info.rateLimitType || 'quota';
      throw new Error(`Rate-limited (${limitType} limit; ${resetsAt})`);
    }

    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      if (ev.message.model === '<synthetic>') {
        const syntheticText = ev.message.content
          .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
          .join(' ')
          .trim();
        throw new Error(`Claude Code: ${syntheticText || 'synthetic error response'}`);
      }
      if (!sawStreamDelta) {
        for (const block of ev.message.content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
            chunks.push({ kind: 'text', text: block.text });
          } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
            chunks.push({ kind: 'thinking', text: block.thinking });
          }
        }
      }
      sawStreamDelta = false;
      return chunks;
    }

    if (ev.type === 'result') {
      if (ev.is_error === true) {
        throw new Error(
          typeof ev.result === 'string' && ev.result ? ev.result : 'Claude Code returned an error'
        );
      }
      const usage = ev.usage as Record<string, any> | undefined;
      const baseIn = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
      const cacheRead = typeof usage?.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
      const cacheCreate =
        typeof usage?.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
      const totalInput = baseIn + cacheRead + cacheCreate;

      chunks.push({
        kind: 'usage',
        inputTokens: totalInput > 0 ? totalInput : undefined,
        cachedInputTokens: cacheRead > 0 ? cacheRead : undefined,
        outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined,
        apiDurationMs: typeof ev.duration_api_ms === 'number' ? ev.duration_api_ms : undefined,
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
      });
      return chunks;
    }

    return chunks;
  };
}

export function createClaudeAdapter(binaryPath = 'claude'): SpeedtestAdapter {
  return {
    id: 'claude',
    name: 'Claude Code',
    category: 'harness',
    supportsToolLoop: true,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      yield* runNdjsonHarness({
        binaryPath,
        label: 'claude',
        req,
        createParser: createClaudeEventParser,
        buildArgs: () => {
          const args = [
            '-p',
            req.prompt,
            '--output-format',
            'stream-json',
            '--verbose',
            '--include-partial-messages',
            '--no-session-persistence',
            '--disable-slash-commands',
            '--effort',
            'low',
          ];
          if (req.enableReadTool) {
            args.push('--tools', 'Read', '--allowedTools', 'Read');
          } else {
            args.push('--tools', '');
          }
          if (req.model && req.model !== 'default') {
            args.push('--model', req.model);
          }
          return args;
        },
      });
    },
  };
}
