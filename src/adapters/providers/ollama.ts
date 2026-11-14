import { Readable } from 'node:stream';
import { TargetFailedError } from '../../core/errors.js';
import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { parseNdjsonStream } from '../utils/ndjson.js';
import { asNumber, ensureOk, guardStream, postForStream, streamErrorEvent, truncatedStreamError } from './http.js';

export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env, override?: string): string {
  const host = (override || env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  return /^https?:\/\//.test(host) ? host : `http://${host}`;
}

const nsToMs = (value: unknown): number | undefined => {
  const ns = asNumber(value);
  return ns === undefined ? undefined : ns / 1e6;
};

/**
 * Maps one /api/chat stream line to chunks. The final line (`done: true`) carries Ollama's own
 * counters, including the real prompt-evaluation time used for the upload (prefill) rate.
 */
export function parseOllamaChunk(raw: unknown): AdapterStreamChunk[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, any>;
  const chunks: AdapterStreamChunk[] = [];

  if (obj.message && typeof obj.message === 'object') {
    if (typeof obj.message.thinking === 'string' && obj.message.thinking.length > 0) {
      chunks.push({ kind: 'thinking', text: obj.message.thinking });
    }
    if (typeof obj.message.content === 'string' && obj.message.content.length > 0) {
      chunks.push({ kind: 'text', text: obj.message.content });
    }
  }

  if (obj.done === true) {
    chunks.push({
      kind: 'usage',
      model: typeof obj.model === 'string' ? obj.model : undefined,
      inputTokens: asNumber(obj.prompt_eval_count),
      outputTokens: asNumber(obj.eval_count),
      promptEvalDurationMs: nsToMs(obj.prompt_eval_duration),
      evalDurationMs: nsToMs(obj.eval_duration),
    });
  }

  return chunks;
}

export function createOllamaAdapter(options?: {
  baseUrl?: string;
  defaultModel?: string;
}): SpeedtestAdapter {
  const name = 'Ollama';
  const baseUrl = ollamaBaseUrl(process.env, options?.baseUrl);

  async function* run(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
    const model = req.model || options?.defaultModel;
    if (!model) {
      throw new TargetFailedError('Ollama needs a model (for example -t ollama:llama3.2)', { kind: 'model' });
    }

    yield { kind: 'start' };
    const res = await postForStream(
      name,
      `${baseUrl}/api/chat`,
      {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: 'user', content: req.prompt }],
          options: req.maxTokens ? { num_predict: req.maxTokens } : undefined,
        }),
      },
      req.signal
    );
    const stream = await ensureOk(name, res);
    yield { kind: 'init', model };

    const lines = Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]);
    try {
      for await (const raw of parseNdjsonStream(lines)) {
        const obj = raw as Record<string, any> | null;
        if (obj && typeof obj === 'object' && typeof obj.error === 'string') {
          throw streamErrorEvent(name, obj.error);
        }
        yield* parseOllamaChunk(raw);
        if (obj && typeof obj === 'object' && obj.done === true) {
          if (obj.done_reason === 'length') {
            yield { kind: 'note', text: 'the answer was cut off at the output token limit' };
          }
          yield { kind: 'terminal' };
          return;
        }
      }
    } finally {
      lines.destroy();
    }
    throw truncatedStreamError(name);
  }

  return {
    id: 'ollama',
    name: 'Ollama (Local)',
    category: 'local',
    tier: 'verified',
    supportsToolLoop: false,
    defaultModel: options?.defaultModel,
    stream: (req) => guardStream(req.signal, run(req)),
  };
}
