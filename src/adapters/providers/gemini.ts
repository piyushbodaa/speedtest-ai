import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { parseSseStream } from '../utils/sse.js';

export function parseGeminiSseData(data: string): AdapterStreamChunk[] {
  if (!data) return [];
  let obj: Record<string, any>;
  try {
    obj = JSON.parse(data) as Record<string, any>;
  } catch {
    return [];
  }

  const chunks: AdapterStreamChunk[] = [];
  const parts = obj.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part && typeof part.text === 'string' && part.text.length > 0) {
        chunks.push({
          kind: part.thought ? 'thinking' : 'text',
          text: part.text,
        });
      }
    }
  }

  if (obj.usageMetadata && typeof obj.usageMetadata === 'object') {
    const u = obj.usageMetadata as Record<string, any>;
    const candidatesTokens = typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : 0;
    const thoughtsTokens = typeof u.thoughtsTokenCount === 'number' ? u.thoughtsTokenCount : 0;
    const totalOut = candidatesTokens + thoughtsTokens;
    chunks.push({
      kind: 'usage',
      model: typeof obj.modelVersion === 'string' ? obj.modelVersion : undefined,
      inputTokens: typeof u.promptTokenCount === 'number' ? u.promptTokenCount : undefined,
      cachedInputTokens:
        typeof u.cachedContentTokenCount === 'number' ? u.cachedContentTokenCount : undefined,
      outputTokens: totalOut > 0 ? totalOut : undefined,
    });
  }

  return chunks;
}

export function createGeminiAdapter(options?: {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}): SpeedtestAdapter {
  const apiKey = options?.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const baseUrl = (options?.baseUrl || 'https://generativelanguage.googleapis.com').replace(
    /\/+$/,
    ''
  );
  const defaultModel = options?.defaultModel || 'gemini-2.5-flash';

  return {
    id: 'gemini',
    name: 'Google Gemini API',
    category: 'provider',
    supportsToolLoop: false,
    defaultModel,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set.');
      }
      const model = req.model || defaultModel;
      const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
          generationConfig: req.maxTokens ? { maxOutputTokens: req.maxTokens } : undefined,
        }),
        signal: req.signal,
      });

      if (!res.ok || !res.body) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Gemini HTTP ${res.status}: ${bodyText || res.statusText}`);
      }

      yield { kind: 'init', model };

      for await (const frame of parseSseStream(res.body)) {
        for (const chunk of parseGeminiSseData(frame.data)) {
          yield chunk;
        }
      }
    },
  };
}
