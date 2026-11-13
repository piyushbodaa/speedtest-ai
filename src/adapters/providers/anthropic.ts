import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { parseSseStream } from '../utils/sse.js';

export function parseAnthropicSseData(data: string): AdapterStreamChunk[] {
  if (!data) return [];
  let obj: Record<string, any>;
  try {
    obj = JSON.parse(data) as Record<string, any>;
  } catch {
    return [];
  }

  const chunks: AdapterStreamChunk[] = [];

  if (obj.type === 'message_start' && obj.message) {
    const usage = obj.message.usage as Record<string, any> | undefined;
    chunks.push({
      kind: 'init',
      model: typeof obj.message.model === 'string' ? obj.message.model : undefined,
    });
    if (usage) {
      const baseIn = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
      const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
      const cacheCreate =
        typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
      const totalIn = baseIn + cacheRead + cacheCreate;
      if (totalIn > 0) {
        chunks.push({
          kind: 'usage',
          inputTokens: totalIn,
          cachedInputTokens: cacheRead > 0 ? cacheRead : undefined,
        });
      }
    }
    return chunks;
  }

  if (obj.type === 'content_block_delta' && obj.delta && typeof obj.delta === 'object') {
    if (obj.delta.type === 'text_delta' && typeof obj.delta.text === 'string' && obj.delta.text.length > 0) {
      chunks.push({ kind: 'text', text: obj.delta.text });
    } else if (
      obj.delta.type === 'thinking_delta' &&
      typeof obj.delta.thinking === 'string' &&
      obj.delta.thinking.length > 0
    ) {
      chunks.push({ kind: 'thinking', text: obj.delta.thinking });
    }
    return chunks;
  }

  if (obj.type === 'message_delta' && obj.usage && typeof obj.usage === 'object') {
    chunks.push({
      kind: 'usage',
      outputTokens: typeof obj.usage.output_tokens === 'number' ? obj.usage.output_tokens : undefined,
    });
    return chunks;
  }

  return chunks;
}

export function createAnthropicAdapter(options?: {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}): SpeedtestAdapter {
  const apiKey = options?.apiKey || process.env.ANTHROPIC_API_KEY;
  const baseUrl = (options?.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const defaultModel = options?.defaultModel || 'claude-sonnet-4-20250514';

  return {
    id: 'anthropic',
    name: 'Anthropic API',
    category: 'provider',
    supportsToolLoop: false,
    defaultModel,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY is not set.');
      }
      const model = req.model || defaultModel;

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 1024,
          stream: true,
          messages: [{ role: 'user', content: req.prompt }],
        }),
        signal: req.signal,
      });

      if (!res.ok || !res.body) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Anthropic HTTP ${res.status}: ${bodyText || res.statusText}`);
      }

      for await (const frame of parseSseStream(res.body)) {
        for (const chunk of parseAnthropicSseData(frame.data)) {
          yield chunk;
        }
      }
    },
  };
}
