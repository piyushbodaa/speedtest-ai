import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { parseSseStream } from '../utils/sse.js';
import {
  asNumber,
  ensureOk,
  guardStream,
  missingKeyError,
  parseJsonObject,
  postForStream,
  REASONING_HEADROOM_TOKENS,
  streamErrorEvent,
  truncatedStreamError,
} from './http.js';

/** Maps one streamGenerateContent event to chunks. `outputTokens` is answer plus thought tokens. */
export function parseGeminiEvent(obj: Record<string, any>): AdapterStreamChunk[] {
  const chunks: AdapterStreamChunk[] = [];
  const parts = obj.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part && typeof part.text === 'string' && part.text.length > 0) {
        chunks.push({ kind: part.thought ? 'thinking' : 'text', text: part.text });
      }
    }
  }

  if (obj.usageMetadata && typeof obj.usageMetadata === 'object') {
    const u = obj.usageMetadata as Record<string, any>;
    const thoughts = asNumber(u.thoughtsTokenCount) ?? 0;
    const totalOut = (asNumber(u.candidatesTokenCount) ?? 0) + thoughts;
    chunks.push({
      kind: 'usage',
      model: typeof obj.modelVersion === 'string' ? obj.modelVersion : undefined,
      inputTokens: asNumber(u.promptTokenCount),
      cachedInputTokens: asNumber(u.cachedContentTokenCount),
      outputTokens: totalOut > 0 ? totalOut : undefined,
      reasoningTokens: thoughts > 0 ? thoughts : undefined,
    });
  }

  return chunks;
}

export function parseGeminiSseData(data: string): AdapterStreamChunk[] {
  const obj = parseJsonObject(data);
  return obj ? parseGeminiEvent(obj) : [];
}

export function createGeminiAdapter(options?: {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}): SpeedtestAdapter {
  const name = 'Google Gemini API';
  // The registry decides which key may go to which endpoint; no fallback to the environment here.
  const apiKey = options?.apiKey;
  const baseUrl = (options?.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const defaultModel = options?.defaultModel || 'gemini-2.5-flash';

  async function* run(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
    if (!apiKey) throw missingKeyError(name, 'GEMINI_API_KEY / GOOGLE_API_KEY');
    const model = req.model || defaultModel;
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

    yield { kind: 'start' };
    const res = await postForStream(
      name,
      url,
      {
        // The key travels in a header so it cannot end up in an error message or a proxy log.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
          // Thought tokens are charged against maxOutputTokens.
          generationConfig: req.maxTokens
            ? { maxOutputTokens: Math.max(req.maxTokens, REASONING_HEADROOM_TOKENS) }
            : undefined,
        }),
      },
      req.signal
    );
    const stream = await ensureOk(name, res);
    yield { kind: 'init', model };

    let finishReason: string | undefined;
    for await (const frame of parseSseStream(stream)) {
      const obj = parseJsonObject(frame.data);
      if (!obj) continue;
      if (obj.error) {
        throw streamErrorEvent(name, String(obj.error.message ?? JSON.stringify(obj.error)));
      }
      const blocked = obj.promptFeedback?.blockReason;
      if (typeof blocked === 'string' && blocked) {
        throw streamErrorEvent(name, `the prompt was blocked (${blocked})`, 'other');
      }
      const reason = obj.candidates?.[0]?.finishReason;
      if (typeof reason === 'string' && reason) finishReason = reason;
      yield* parseGeminiEvent(obj);
    }

    if (!finishReason) throw truncatedStreamError(name);
    if (finishReason === 'MAX_TOKENS') {
      yield { kind: 'note', text: 'the answer was cut off at the output token limit' };
    } else if (finishReason !== 'STOP') {
      throw streamErrorEvent(name, `generation stopped early (${finishReason})`, 'other');
    }
    yield { kind: 'terminal' };
  }

  return {
    id: 'gemini-api',
    name,
    category: 'provider',
    tier: 'verified',
    supportsToolLoop: false,
    defaultModel,
    stream: (req) => guardStream(req.signal, run(req)),
  };
}
