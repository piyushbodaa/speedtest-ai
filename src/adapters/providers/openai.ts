import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter, TargetCategory } from '../../types.js';
import { parseSseStream } from '../utils/sse.js';

export function parseOpenAiSseData(data: string): AdapterStreamChunk[] {
  if (!data || data === '[DONE]') return [];
  let obj: Record<string, any>;
  try {
    obj = JSON.parse(data) as Record<string, any>;
  } catch {
    return [];
  }

  const chunks: AdapterStreamChunk[] = [];
  const delta = obj.choices?.[0]?.delta as Record<string, any> | undefined;

  if (delta) {
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      chunks.push({ kind: 'thinking', text: delta.reasoning_content });
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      chunks.push({ kind: 'text', text: delta.content });
    }
  }

  if (obj.usage && typeof obj.usage === 'object') {
    const usage = obj.usage as Record<string, any>;
    chunks.push({
      kind: 'usage',
      model: typeof obj.model === 'string' ? obj.model : undefined,
      inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
      cachedInputTokens:
        typeof usage.prompt_tokens_details?.cached_tokens === 'number'
          ? usage.prompt_tokens_details.cached_tokens
          : undefined,
      outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    });
  }

  return chunks;
}

export function createOpenAiCompatibleAdapter(options: {
  id: string;
  name: string;
  category: TargetCategory;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  extraHeaders?: Record<string, string>;
}): SpeedtestAdapter {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    id: options.id,
    name: options.name,
    category: options.category,
    supportsToolLoop: false,
    defaultModel: options.defaultModel,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      const model = req.model || options.defaultModel;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...options.extraHeaders,
      };
      if (options.apiKey) {
        headers.Authorization = `Bearer ${options.apiKey}`;
      }

      const buildBody = (includeUsage: boolean) =>
        JSON.stringify({
          model,
          stream: true,
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          messages: [{ role: 'user', content: req.prompt }],
        });

      let res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: buildBody(true),
        signal: req.signal,
      });

      // Fallback if OpenAI-compatible server rejects stream_options with HTTP 400
      if (res.status === 400) {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: buildBody(false),
          signal: req.signal,
        });
      }

      if (!res.ok || !res.body) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`${options.name} HTTP ${res.status}: ${bodyText || res.statusText}`);
      }

      yield { kind: 'init', model };

      for await (const frame of parseSseStream(res.body)) {
        for (const chunk of parseOpenAiSseData(frame.data)) {
          yield chunk;
        }
      }
    },
  };
}
