import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseAnthropicSseData } from '../src/adapters/providers/anthropic.js';
import { parseGeminiSseData } from '../src/adapters/providers/gemini.js';
import { parseOllamaChunk } from '../src/adapters/providers/ollama.js';
import { parseOpenAiSseData } from '../src/adapters/providers/openai.js';
import { parseNdjsonStream } from '../src/adapters/utils/ndjson.js';
import { parseSseStream } from '../src/adapters/utils/sse.js';

describe('Provider & stream parsers', () => {
  it('parses OpenAI SSE chunks including reasoning_content and usage', () => {
    const c1 = parseOpenAiSseData(
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think ' } }] })
    );
    const c2 = parseOpenAiSseData(JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }));
    const c3 = parseOpenAiSseData(
      JSON.stringify({ model: 'gpt-4.1-mini', usage: { prompt_tokens: 15, completion_tokens: 3 } })
    );

    expect(c1[0]).toEqual({ kind: 'thinking', text: 'think ' });
    expect(c2[0]).toEqual({ kind: 'text', text: 'answer' });
    expect(c3[0]).toMatchObject({ kind: 'usage', model: 'gpt-4.1-mini', inputTokens: 15, outputTokens: 3 });
  });

  it('parses Anthropic SSE events', () => {
    const start = parseAnthropicSseData(
      JSON.stringify({
        type: 'message_start',
        message: { model: 'claude-sonnet-4', usage: { input_tokens: 30, cache_read_input_tokens: 10 } },
      })
    );
    const delta = parseAnthropicSseData(
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Pong' } })
    );
    const end = parseAnthropicSseData(
      JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1 } })
    );

    expect(start.find((c) => c.kind === 'usage')?.inputTokens).toBe(40);
    expect(delta[0]).toEqual({ kind: 'text', text: 'Pong' });
    expect(end[0]).toEqual({ kind: 'usage', outputTokens: 1 });
  });

  it('parses Gemini SSE events including thoughtsTokenCount', () => {
    const thought = parseGeminiSseData(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'step1', thought: true }] } }] })
    );
    const text = parseGeminiSseData(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'done' }] } }],
        modelVersion: 'gemini-2.5-flash',
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, thoughtsTokenCount: 4 },
      })
    );

    expect(thought[0]).toEqual({ kind: 'thinking', text: 'step1' });
    expect(text[0]).toEqual({ kind: 'text', text: 'done' });
    expect(text[1]).toMatchObject({ kind: 'usage', inputTokens: 12, outputTokens: 6 });
  });

  it('parses Ollama NDJSON chunks and converts nanoseconds to ms', () => {
    const delta = parseOllamaChunk({ message: { content: 'hi' }, done: false });
    const done = parseOllamaChunk({
      model: 'llama3.2',
      done: true,
      prompt_eval_count: 50,
      eval_count: 100,
      prompt_eval_duration: 25_000_000,
      eval_duration: 1_000_000_000,
    });

    expect(delta[0]).toEqual({ kind: 'text', text: 'hi' });
    expect(done[0]).toMatchObject({
      kind: 'usage',
      model: 'llama3.2',
      inputTokens: 50,
      outputTokens: 100,
      promptEvalDurationMs: 25,
      evalDurationMs: 1000,
    });
  });

  it('handles fragmented NDJSON and SSE streams cleanly', async () => {
    const ndjson = Readable.from(['{"a":1}\n{"b":', '2}\n']);
    const parsedNdjson: unknown[] = [];
    for await (const item of parseNdjsonStream(ndjson)) {
      parsedNdjson.push(item);
    }
    expect(parsedNdjson).toEqual([{ a: 1 }, { b: 2 }]);

    const encoder = new TextEncoder();
    const sseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"x":1}\n\n'));
        controller.enqueue(encoder.encode('data: {"x":'));
        controller.enqueue(encoder.encode('2}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const frames: string[] = [];
    for await (const frame of parseSseStream(sseStream)) {
      frames.push(frame.data);
    }
    expect(frames).toEqual(['{"x":1}', '{"x":2}']);
  });
});
