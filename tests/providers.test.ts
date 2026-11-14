import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from '../src/adapters/providers/anthropic.js';
import { createGeminiAdapter } from '../src/adapters/providers/gemini.js';
import { createOllamaAdapter } from '../src/adapters/providers/ollama.js';
import { createOpenAiCompatibleAdapter } from '../src/adapters/providers/openai.js';
import { parseSseStream } from '../src/adapters/utils/sse.js';
import {
  InterruptedError,
  isInterruptedError,
  isPhaseTimeoutError,
  isTargetFailedError,
  PhaseTimeoutError,
} from '../src/core/errors.js';
import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../src/types.js';

interface Scripted {
  status?: number;
  body?: string;
  /** Written one by one with a short pause, then the response ends. */
  frames?: string[];
  /** Keep the connection open after the frames. */
  hang?: boolean;
}

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

let server: http.Server;
let baseUrl: string;
let next: Scripted[] = [];
const seen: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const script = next.shift() ?? { status: 500, body: 'no script' };
      res.writeHead(script.status ?? 200, { 'Content-Type': 'text/event-stream' });
      if (script.body !== undefined) {
        res.end(script.body);
        return;
      }
      for (const frame of script.frames ?? []) {
        res.write(frame);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (!script.hang) res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function request(overrides: Partial<AdapterInvokeRequest> = {}): AdapterInvokeRequest {
  return { phase: 'download', prompt: 'hello', maxTokens: 64, signal: new AbortController().signal, ...overrides };
}

async function collect(adapter: SpeedtestAdapter, req = request()): Promise<AdapterStreamChunk[]> {
  const chunks: AdapterStreamChunk[] = [];
  for await (const chunk of adapter.stream(req)) chunks.push(chunk);
  return chunks;
}

function script(...responses: Scripted[]): void {
  next = responses;
  seen.length = 0;
}

const sse = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const kinds = (chunks: AdapterStreamChunk[]) => chunks.map((c) => c.kind);
const text = (chunks: AdapterStreamChunk[]) =>
  chunks
    .filter((c) => c.kind === 'text')
    .map((c) => c.text)
    .join('');

const openai = (extra: Partial<Parameters<typeof createOpenAiCompatibleAdapter>[0]> = {}) =>
  createOpenAiCompatibleAdapter({
    id: 'openai',
    name: 'OpenAI API',
    category: 'provider',
    baseUrl,
    apiKey: 'sk-test',
    defaultModel: 'm-default',
    ...extra,
  });

describe('OpenAI-compatible provider', () => {
  it('starts the clock at the request and ends with a terminal chunk after [DONE]', async () => {
    script({
      frames: [
        sse({ choices: [{ delta: { reasoning_content: 'hm ' } }] }),
        sse({ choices: [{ delta: { content: 'Hel' } }] }),
        sse({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }),
        sse({
          model: 'm-real',
          choices: [],
          usage: {
            prompt_tokens: 9,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 4 },
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        }),
        sse('[DONE]'),
      ],
    });

    const chunks = await collect(openai());

    expect(kinds(chunks)).toEqual(['start', 'init', 'thinking', 'text', 'text', 'usage', 'terminal']);
    expect(text(chunks)).toBe('Hello');
    expect(chunks.find((c) => c.kind === 'usage')).toMatchObject({
      model: 'm-real',
      inputTokens: 9,
      cachedInputTokens: 4,
      outputTokens: 5,
      reasoningTokens: 2,
    });
    expect(seen[0].url).toBe('/chat/completions');
    expect(seen[0].headers.authorization).toBe('Bearer sk-test');
    expect(seen[0].body).toMatchObject({ model: 'm-default', stream: true, max_tokens: 64 });
  });

  it('retries a 400 with the bare request and restarts the clock', async () => {
    script(
      { status: 400, body: '{"error":{"message":"Unsupported parameter: max_tokens"}}' },
      { frames: [sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), sse('[DONE]')] }
    );

    const chunks = await collect(openai());

    expect(kinds(chunks)).toEqual(['start', 'start', 'init', 'text', 'terminal']);
    expect(seen[1].body.max_tokens).toBeUndefined();
    expect(seen[1].body.stream_options).toBeUndefined();
  });

  it('classifies HTTP failures', async () => {
    script({ status: 401, body: '{"error":{"message":"Incorrect API key provided"}}' });
    const auth = await collect(openai()).catch((e) => e);
    expect(isTargetFailedError(auth)).toBe(true);
    expect(auth).toMatchObject({ kind: 'auth', message: 'OpenAI API HTTP 401: Incorrect API key provided' });

    script({ status: 429, body: 'slow down' });
    expect((await collect(openai()).catch((e) => e)).kind).toBe('rate_limit');

    script({ status: 404, body: '{"error":{"message":"The model `nope` does not exist"}}' });
    expect((await collect(openai()).catch((e) => e)).kind).toBe('model');
  });

  it('fails before any request when a required key is missing', async () => {
    script();
    const error = await collect(openai({ apiKey: undefined, requireApiKey: 'OPENAI_API_KEY' })).catch((e) => e);
    expect(error).toMatchObject({ kind: 'auth' });
    expect(error.message).toContain('OPENAI_API_KEY');
    expect(seen).toHaveLength(0);
  });

  it('treats a stream that ends without [DONE] or a finish reason as a failure, not a result', async () => {
    script({ frames: [sse({ choices: [{ delta: { content: 'partial' } }] })] });
    const error = await collect(openai()).catch((e) => e);
    expect(isTargetFailedError(error)).toBe(true);
    expect(error.message).toMatch(/ended before the response was complete/);
  });

  it('surfaces an error event sent inside the stream', async () => {
    script({ frames: [sse({ error: { message: 'Rate limit reached for requests' } })] });
    const error = await collect(openai()).catch((e) => e);
    expect(error).toMatchObject({ kind: 'rate_limit' });
  });

  it('throws the interrupt or timeout itself when aborted mid-stream', async () => {
    for (const reason of [new InterruptedError(), new PhaseTimeoutError('too slow', { timeoutMs: 100 })]) {
      script({ frames: [sse({ choices: [{ delta: { content: 'partial' } }] })], hang: true });
      const controller = new AbortController();
      const run = collect(openai(), request({ signal: controller.signal }));
      setTimeout(() => controller.abort(reason), 120);
      const error = await run.catch((e) => e);
      expect(isInterruptedError(error) || isPhaseTimeoutError(error)).toBe(true);
      expect(error).toBe(reason);
    }
  });

  it('reports an unreachable server as a target failure', async () => {
    const adapter = openai({ baseUrl: 'http://127.0.0.1:1' });
    const error = await collect(adapter).catch((e) => e);
    expect(isTargetFailedError(error)).toBe(true);
    expect(error.message).toMatch(/request failed/);
  });
});

describe('Anthropic provider', () => {
  const adapter = () => createAnthropicAdapter({ apiKey: 'k', baseUrl, defaultModel: 'claude-test' });

  it('maps the Messages stream and stops at message_stop', async () => {
    script({
      frames: [
        `event: message_start\n${sse({
          type: 'message_start',
          message: { model: 'claude-test-1', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
        })}`,
        sse({ type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } }),
        sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } }),
        sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Pong' } }),
        sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
        sse({ type: 'message_stop' }),
      ],
    });

    const chunks = await collect(adapter(), request({ maxTokens: 64 }));

    expect(kinds(chunks)).toEqual(['start', 'meta', 'init', 'usage', 'activity', 'text', 'usage', 'terminal']);
    expect(chunks.find((c) => c.kind === 'init')?.model).toBe('claude-test-1');
    expect(chunks.find((c) => c.kind === 'usage')).toMatchObject({ inputTokens: 15, cachedInputTokens: 5 });
    expect(seen[0].url).toBe('/v1/messages');
    expect(seen[0].headers['x-api-key']).toBe('k');
    // Hidden thinking is charged against max_tokens, so the phase's tiny cap is raised.
    expect(seen[0].body.max_tokens).toBe(4096);
    expect(seen[0].body.temperature).toBeUndefined();
  });

  it('fails on an error event, a refusal and a cut-off stream', async () => {
    script({ frames: [sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })] });
    expect(await collect(adapter()).catch((e) => e)).toMatchObject({ kind: 'rate_limit' });

    script({
      frames: [sse({ type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: {} }), sse({ type: 'message_stop' })],
    });
    await expect(collect(adapter())).rejects.toThrow(/declined/);

    script({ frames: [sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'half' } })] });
    await expect(collect(adapter())).rejects.toThrow(/ended before the response was complete/);
  });

  it('notes an answer cut off by the token limit', async () => {
    script({
      frames: [
        sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'long' } }),
        sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } }),
        sse({ type: 'message_stop' }),
      ],
    });
    const chunks = await collect(adapter());
    expect(chunks.find((c) => c.kind === 'note')?.text).toMatch(/cut off/);
    expect(chunks.at(-1)?.kind).toBe('terminal');
  });

  it('defaults to a current model', () => {
    expect(createAnthropicAdapter({ apiKey: 'k' }).defaultModel).toBe('claude-sonnet-5-5');
  });
});

describe('Gemini API provider', () => {
  const adapter = () => createGeminiAdapter({ apiKey: 'secret-key', baseUrl, defaultModel: 'gem-test' });

  it('sends the key in a header and requires a finish reason', async () => {
    script({
      frames: [
        sse({ candidates: [{ content: { parts: [{ text: 'plan', thought: true }] } }] }),
        sse({ candidates: [{ content: { parts: [{ text: 'answer' }] } }] }),
        sse({
          candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
          modelVersion: 'gem-test-001',
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, thoughtsTokenCount: 5 },
        }),
      ],
    });

    const chunks = await collect(adapter());

    expect(kinds(chunks)).toEqual(['start', 'init', 'thinking', 'text', 'usage', 'terminal']);
    expect(chunks.find((c) => c.kind === 'usage')).toMatchObject({
      model: 'gem-test-001',
      inputTokens: 8,
      outputTokens: 8,
      reasoningTokens: 5,
    });
    expect(seen[0].url).toBe('/v1beta/models/gem-test:streamGenerateContent?alt=sse');
    expect(seen[0].url).not.toContain('secret-key');
    expect(seen[0].headers['x-goog-api-key']).toBe('secret-key');
    expect(adapter().id).toBe('gemini-api');
  });

  it('fails on a blocked prompt, an abnormal finish and a cut-off stream', async () => {
    script({ frames: [sse({ promptFeedback: { blockReason: 'SAFETY' } })] });
    await expect(collect(adapter())).rejects.toThrow(/blocked \(SAFETY\)/);

    script({ frames: [sse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'RECITATION' }] })] });
    await expect(collect(adapter())).rejects.toThrow(/stopped early \(RECITATION\)/);

    script({ frames: [sse({ candidates: [{ content: { parts: [{ text: 'half' }] } }] })] });
    await expect(collect(adapter())).rejects.toThrow(/ended before the response was complete/);
  });
});

describe('Ollama provider', () => {
  const adapter = () => createOllamaAdapter({ baseUrl, defaultModel: 'llama-test' });
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;

  it('reports the real prompt-eval duration on the terminal line', async () => {
    script({
      frames: [
        line({ message: { thinking: 'hm' }, done: false }),
        line({ message: { content: 'Hi' }, done: false }),
        line({
          model: 'llama-test',
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 40,
          eval_count: 12,
          prompt_eval_duration: 20_000_000,
          eval_duration: 300_000_000,
        }),
      ],
    });

    const chunks = await collect(adapter());

    expect(kinds(chunks)).toEqual(['start', 'init', 'thinking', 'text', 'usage', 'terminal']);
    expect(chunks.find((c) => c.kind === 'usage')).toMatchObject({
      inputTokens: 40,
      outputTokens: 12,
      promptEvalDurationMs: 20,
      evalDurationMs: 300,
    });
    expect(seen[0].url).toBe('/api/chat');
    expect(seen[0].body).toMatchObject({ model: 'llama-test', stream: true, options: { num_predict: 64 } });
  });

  it('fails on an error line, an unknown model and a cut-off stream', async () => {
    script({ frames: [line({ error: 'model runner has unexpectedly stopped' })] });
    await expect(collect(adapter())).rejects.toThrow(/unexpectedly stopped/);

    script({ status: 404, body: '{"error":"model \'nope\' not found"}' });
    expect(await collect(adapter()).catch((e) => e)).toMatchObject({ kind: 'model' });

    script({ frames: [line({ message: { content: 'half' }, done: false })] });
    await expect(collect(adapter())).rejects.toThrow(/ended before the response was complete/);
  });

  it('needs a model', async () => {
    const error = await collect(createOllamaAdapter({ baseUrl })).catch((e) => e);
    expect(error).toMatchObject({ kind: 'model' });
  });
});

describe('SSE reader', () => {
  const stream = (parts: Array<string | Uint8Array>) => {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part);
        controller.close();
      },
    });
  };
  const read = async (body: ReadableStream<Uint8Array>, emitDone = false) => {
    const frames: string[] = [];
    for await (const frame of parseSseStream(body, { emitDone })) frames.push(frame.data);
    return frames;
  };

  it('keeps a multi-byte character that is split across network chunks', async () => {
    const bytes = new TextEncoder().encode('data: {"t":"héllo 🚀"}\n\n');
    const cut = bytes.indexOf(0xf0) + 2;
    expect(await read(stream([bytes.slice(0, cut), bytes.slice(cut)]))).toEqual(['{"t":"héllo 🚀"}']);
  });

  it('handles CRLF, comments, multi-line data and a final frame without a blank line', async () => {
    const frames = await read(stream([': keepalive\r\n\r\ndata: a\r\ndata: b\r\n\r\ndata:c']));
    expect(frames).toEqual(['a\nb', 'c']);
  });

  it('reports [DONE] only when asked and never reads past it', async () => {
    const body = () => stream(['data: 1\n\ndata: [DONE]\n\ndata: 2\n\n']);
    expect(await read(body())).toEqual(['1']);
    expect(await read(body(), true)).toEqual(['1', '[DONE]']);
  });

  it('cancels the connection when the consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('data: x\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const frame of parseSseStream(body)) {
      expect(frame.data).toBe('x');
      break;
    }
    expect(cancelled).toBe(true);
  });
});
