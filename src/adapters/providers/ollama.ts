import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { parseNdjsonStream } from '../utils/ndjson.js';
import { Readable } from 'node:stream';

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
      inputTokens: typeof obj.prompt_eval_count === 'number' ? obj.prompt_eval_count : undefined,
      outputTokens: typeof obj.eval_count === 'number' ? obj.eval_count : undefined,
      promptEvalDurationMs:
        typeof obj.prompt_eval_duration === 'number' ? obj.prompt_eval_duration / 1e6 : undefined,
      evalDurationMs:
        typeof obj.eval_duration === 'number' ? obj.eval_duration / 1e6 : undefined,
    });
  }

  return chunks;
}

export function createOllamaAdapter(options?: {
  baseUrl?: string;
  defaultModel?: string;
}): SpeedtestAdapter {
  const host = (options?.baseUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(
    /\/+$/,
    ''
  );
  const baseUrl = host.startsWith('http') ? host : `http://${host}`;

  return {
    id: 'ollama',
    name: 'Ollama (Local)',
    category: 'local',
    supportsToolLoop: false,
    defaultModel: options?.defaultModel,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      const model = req.model || options?.defaultModel;
      if (!model) {
        throw new Error('Ollama requires a model (e.g. -t ollama:llama3.2).');
      }

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: 'user', content: req.prompt }],
          options: req.maxTokens ? { num_predict: req.maxTokens } : undefined,
        }),
        signal: req.signal,
      });

      if (!res.ok || !res.body) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Ollama HTTP ${res.status}: ${bodyText || res.statusText}`);
      }

      yield { kind: 'init', model };

      const nodeReadable = Readable.fromWeb(res.body as any);
      for await (const raw of parseNdjsonStream(nodeReadable)) {
        for (const chunk of parseOllamaChunk(raw)) {
          yield chunk;
        }
      }
    },
  };
}
