import type { FailureKind } from '../../core/errors.js';
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

/**
 * Maps one Messages API stream event to chunks. `inputTokens` includes cache reads and cache
 * writes. `message_stop` becomes the terminal chunk.
 */
export function parseAnthropicEvent(obj: Record<string, any>): AdapterStreamChunk[] {
  const chunks: AdapterStreamChunk[] = [];

  if (obj.type === 'message_start' && obj.message) {
    const usage = obj.message.usage as Record<string, any> | undefined;
    chunks.push({
      kind: 'init',
      model: typeof obj.message.model === 'string' ? obj.message.model : undefined,
    });
    if (usage) {
      const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0;
      const totalIn =
        (asNumber(usage.input_tokens) ?? 0) + cacheRead + (asNumber(usage.cache_creation_input_tokens) ?? 0);
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

  // Current models think by default and return the thinking block with empty text, so the block
  // start is the only sign that the model is working before the first visible token.
  if (obj.type === 'content_block_start' && obj.content_block?.type === 'thinking') {
    return [{ kind: 'activity' }];
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
    chunks.push({ kind: 'usage', outputTokens: asNumber(obj.usage.output_tokens) });
    return chunks;
  }

  if (obj.type === 'message_stop') return [{ kind: 'terminal' }];

  return chunks;
}

export function parseAnthropicSseData(data: string): AdapterStreamChunk[] {
  const obj = parseJsonObject(data);
  return obj ? parseAnthropicEvent(obj) : [];
}

const ERROR_KINDS: Record<string, FailureKind> = {
  authentication_error: 'auth',
  permission_error: 'auth',
  rate_limit_error: 'rate_limit',
  overloaded_error: 'rate_limit',
  not_found_error: 'model',
};

export function createAnthropicAdapter(options?: {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}): SpeedtestAdapter {
  const name = 'Anthropic API';
  // The registry decides which key may go to which endpoint; no fallback to the environment here.
  const apiKey = options?.apiKey;
  const baseUrl = (options?.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const defaultModel = options?.defaultModel || 'claude-sonnet-5-5';

  async function* run(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
    if (!apiKey) throw missingKeyError(name, 'ANTHROPIC_API_KEY');
    const model = req.model || defaultModel;

    yield { kind: 'start' };
    const res = await postForStream(
      name,
      `${baseUrl}/v1/messages`,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          // Thinking is charged against max_tokens, so the phase's own small cap would starve the answer.
          max_tokens: Math.max(req.maxTokens ?? 0, REASONING_HEADROOM_TOKENS),
          stream: true,
          messages: [{ role: 'user', content: req.prompt }],
        }),
      },
      req.signal
    );
    const stream = await ensureOk(name, res);
    yield { kind: 'meta', model };

    let stopReason: string | undefined;
    for await (const frame of parseSseStream(stream)) {
      const obj = parseJsonObject(frame.data);
      if (!obj) continue;
      if (obj.type === 'error') {
        const type = typeof obj.error?.type === 'string' ? obj.error.type : '';
        const message = typeof obj.error?.message === 'string' ? obj.error.message : type || 'stream error';
        throw streamErrorEvent(name, message, ERROR_KINDS[type]);
      }
      if (obj.type === 'message_delta' && typeof obj.delta?.stop_reason === 'string') {
        stopReason = obj.delta.stop_reason;
      }
      if (obj.type === 'message_stop') {
        if (stopReason === 'refusal') throw streamErrorEvent(name, 'the model declined the benchmark prompt', 'other');
        if (stopReason === 'max_tokens') {
          yield { kind: 'note', text: 'the answer was cut off at the output token limit' };
        }
        yield { kind: 'terminal' };
        return;
      }
      yield* parseAnthropicEvent(obj);
    }
    throw truncatedStreamError(name);
  }

  return {
    id: 'anthropic',
    name,
    category: 'provider',
    tier: 'verified',
    supportsToolLoop: false,
    defaultModel,
    stream: (req) => guardStream(req.signal, run(req)),
  };
}
