import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter, TargetCategory } from '../../types.js';
import { parseSseStream, SSE_DONE } from '../utils/sse.js';
import {
  asNumber,
  ensureOk,
  guardStream,
  missingKeyError,
  parseJsonObject,
  postForStream,
  streamErrorEvent,
  truncatedStreamError,
} from './http.js';

/** Maps one decoded chat-completions stream object to chunks. Usage arrives as a `usage` chunk. */
export function parseOpenAiEvent(obj: Record<string, any>): AdapterStreamChunk[] {
  const chunks: AdapterStreamChunk[] = [];
  const delta = obj.choices?.[0]?.delta as Record<string, any> | undefined;

  if (delta) {
    // `reasoning_content` (DeepSeek, vLLM, LM Studio) and `reasoning` (OpenRouter) both carry thinking.
    const reasoning =
      typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' && delta.reasoning.length > 0
          ? delta.reasoning
          : undefined;
    if (reasoning) chunks.push({ kind: 'thinking', text: reasoning });
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      chunks.push({ kind: 'text', text: delta.content });
    }
  }

  if (obj.usage && typeof obj.usage === 'object') {
    const usage = obj.usage as Record<string, any>;
    chunks.push({
      kind: 'usage',
      model: typeof obj.model === 'string' ? obj.model : undefined,
      inputTokens: asNumber(usage.prompt_tokens),
      cachedInputTokens: asNumber(usage.prompt_tokens_details?.cached_tokens),
      outputTokens: asNumber(usage.completion_tokens),
      reasoningTokens: asNumber(usage.completion_tokens_details?.reasoning_tokens),
    });
  }

  return chunks;
}

export function parseOpenAiSseData(data: string): AdapterStreamChunk[] {
  if (!data || data === SSE_DONE) return [];
  const obj = parseJsonObject(data);
  return obj ? parseOpenAiEvent(obj) : [];
}

export function createOpenAiCompatibleAdapter(options: {
  id: string;
  name: string;
  category: TargetCategory;
  baseUrl: string;
  apiKey?: string;
  /** Names of the env vars that hold the key; when set, a missing key fails before any request. */
  requireApiKey?: string;
  defaultModel: string;
  extraHeaders?: Record<string, string>;
}): SpeedtestAdapter {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  async function* run(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
    if (options.requireApiKey && !options.apiKey) throw missingKeyError(options.name, options.requireApiKey);
    const model = req.model || options.defaultModel;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...options.extraHeaders,
    };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

    const body = (full: boolean) =>
      JSON.stringify({
        model,
        stream: true,
        ...(full ? { stream_options: { include_usage: true } } : {}),
        ...(full && req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        messages: [{ role: 'user', content: req.prompt }],
      });

    yield { kind: 'start' };
    let res = await postForStream(options.name, url, { headers, body: body(true) }, req.signal);
    if (res.status === 400) {
      // Some servers reject `stream_options`, and reasoning models reject `max_tokens`; the bare
      // request is accepted by all of them. The clock restarts with the request that is answered.
      await res.body?.cancel().catch(() => {});
      yield { kind: 'start' };
      res = await postForStream(options.name, url, { headers, body: body(false) }, req.signal);
    }
    const stream = await ensureOk(options.name, res);
    yield { kind: 'init', model };

    let finishReason: string | undefined;
    let sawDone = false;
    for await (const frame of parseSseStream(stream, { emitDone: true })) {
      if (frame.data === SSE_DONE) {
        sawDone = true;
        break;
      }
      const obj = parseJsonObject(frame.data);
      if (!obj) continue;
      if (obj.error) {
        const message =
          typeof obj.error === 'string' ? obj.error : String(obj.error.message ?? JSON.stringify(obj.error));
        throw streamErrorEvent(options.name, message);
      }
      const reason = obj.choices?.[0]?.finish_reason;
      if (typeof reason === 'string' && reason) finishReason = reason;
      yield* parseOpenAiEvent(obj);
    }

    if (!sawDone && !finishReason) throw truncatedStreamError(options.name);
    if (finishReason === 'length') {
      yield { kind: 'note', text: 'the answer was cut off at the output token limit' };
    }
    yield { kind: 'terminal' };
  }

  return {
    id: options.id,
    name: options.name,
    category: options.category,
    tier: 'verified',
    supportsToolLoop: false,
    defaultModel: options.defaultModel,
    stream: (req) => guardStream(req.signal, run(req)),
  };
}
