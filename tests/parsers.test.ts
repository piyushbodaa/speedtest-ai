import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAgyEventParser } from '../src/adapters/harnesses/agy.js';
import { createClaudeEventParser } from '../src/adapters/harnesses/claude.js';
import { createCodexEventParser } from '../src/adapters/harnesses/codex.js';
import { createGrokEventParser } from '../src/adapters/harnesses/grok.js';
import { createMuseEventParser } from '../src/adapters/harnesses/muse.js';
import { parseAnthropicSseData } from '../src/adapters/providers/anthropic.js';
import { parseGeminiSseData } from '../src/adapters/providers/gemini.js';
import { parseOllamaChunk } from '../src/adapters/providers/ollama.js';
import { parseOpenAiSseData } from '../src/adapters/providers/openai.js';
import { parseNdjsonStream } from '../src/adapters/utils/ndjson.js';
import { parseSseStream } from '../src/adapters/utils/sse.js';

describe('Harness NDJSON parsers', () => {
  it('claude parser extracts deltas without double-counting summary assistant message', () => {
    const parse = createClaudeEventParser();
    const events = [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm ' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      },
      {
        type: 'result',
        duration_api_ms: 420,
        total_cost_usd: 0.002,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 5,
          output_tokens: 2,
        },
      },
    ];

    const out = events.flatMap(parse);
    const texts = out.filter((c) => c.kind === 'text').map((c) => c.text);
    const thinkings = out.filter((c) => c.kind === 'thinking').map((c) => c.text);
    const usage = out.find((c) => c.kind === 'usage');

    expect(texts.join('')).toBe('Hello world');
    expect(thinkings.join('')).toBe('hmm ');
    expect(usage?.inputTokens).toBe(65);
    expect(usage?.outputTokens).toBe(2);
    expect(usage?.apiDurationMs).toBe(420);
  });

  it('codex parser computes incremental diff slices across item.updated and item.completed', () => {
    const parse = createCodexEventParser();
    const events = [
      { type: 'thread.started', model: 'gpt-5-codex' },
      { type: 'item.started', item: { id: 'cmd_1', type: 'command_execution' } },
      { type: 'item.updated', item: { id: 'msg_1', type: 'agent_message', text: 'Hello' } },
      { type: 'item.updated', item: { id: 'msg_1', type: 'agent_message', text: 'Hello world' } },
      { type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: 'Hello world!' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 120, cached_input_tokens: 30, output_tokens: 4 },
      },
    ];

    const out = events.flatMap(parse);
    expect(out.filter((c) => c.kind === 'tool_call').length).toBe(1);
    expect(
      out
        .filter((c) => c.kind === 'text')
        .map((c) => c.text)
        .join('')
    ).toBe('Hello world!');
    expect(out.find((c) => c.kind === 'usage')?.outputTokens).toBe(4);
  });

  it('agy, grok, and muse parsers extract deltas, tool calls, and usage without double-counting', () => {
    for (const createParser of [createAgyEventParser, createGrokEventParser, createMuseEventParser]) {
      const parse = createParser();
      const out = [
        { type: 'init', model: 'test-model' },
        { type: 'text_delta', text: 'Part 1 ' },
        { type: 'text_delta', text: 'Part 2' },
        { type: 'tool_call', name: 'Read' },
        { type: 'assistant', content: 'Part 1 Part 2' },
        { type: 'result', result: 'Part 1 Part 2', usage: { input_tokens: 20, output_tokens: 5 } },
      ].flatMap(parse);

      expect(
        out
          .filter((c) => c.kind === 'text')
          .map((c) => c.text)
          .join('')
      ).toBe('Part 1 Part 2');
      expect(out.find((c) => c.kind === 'tool_call')?.toolName).toBe('Read');
      expect(out.find((c) => c.kind === 'usage')?.outputTokens).toBe(5);
    }
  });

  it('agy parser handles real stream-json event & step_update schemas', () => {
    const parse = createAgyEventParser();
    const events = [
      { event: 'init', init: { model: 'gemini-4-carbon-low' } },
      { event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE' } },
      { event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Speed ' } },
      { event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: 'test' } },
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          duration_seconds: 1.5,
          response: 'Speed test',
          usage: { input_tokens: 100, cache_read_tokens: 20, output_tokens: 12 },
        },
      },
    ];
    const out = events.flatMap(parse);
    expect(out.find((c) => c.kind === 'init')?.model).toBe('gemini-4-carbon-low');
    expect(out.filter((c) => c.kind === 'text').map((c) => c.text).join('')).toBe('Speed test');
    expect(out.find((c) => c.kind === 'usage')).toMatchObject({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 12,
      apiDurationMs: 1500,
    });
  });

  it('grok parser handles streaming-messages-json and direct text events', () => {
    const parse1 = createGrokEventParser();
    const out1 = [
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'grok-4.7' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fast ' } } },
      { type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 50, cache_read_input_tokens: 10, output_tokens: 5 } } },
    ].flatMap(parse1);
    expect(out1.find((c) => c.kind === 'init')?.model).toBe('grok-4.7');
    expect(out1.find((c) => c.kind === 'text')?.text).toBe('Fast ');
    expect(out1.find((c) => c.kind === 'usage')).toMatchObject({ inputTokens: 60, outputTokens: 5 });

    const parse2 = createGrokEventParser();
    const out2 = [
      { type: 'thought', data: 'thinking ' },
      { type: 'text', data: 'answer' },
    ].flatMap(parse2);
    expect(out2.find((c) => c.kind === 'thinking')?.text).toBe('thinking ');
    expect(out2.find((c) => c.kind === 'text')?.text).toBe('answer');
  });

  it('muse parser handles MSP run.model.configured and run.output.delta schemas', () => {
    const parse = createMuseEventParser();
    const events = [
      {
        schema_version: 1,
        payload_type: 'run.model.configured',
        payload: { model_id: 'muse-spark-1.3', display_label: 'muse-spark-1.3' },
      },
      {
        schema_version: 1,
        payload_type: 'run.output.delta',
        payload: { text: 'Hello ' },
      },
      {
        schema_version: 1,
        payload_type: 'run.output.delta',
        payload: { text: 'Muse' },
      },
    ];
    const out = events.flatMap(parse);
    expect(out.find((c) => c.kind === 'init')?.model).toBe('muse-spark-1.3');
    expect(out.filter((c) => c.kind === 'text').map((c) => c.text).join('')).toBe('Hello Muse');
  });

  it('claude parser rejects rate-limit and synthetic error events instead of counting error text as TPS', () => {
    const parseRate = createClaudeEventParser();
    expect(() =>
      parseRate({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1794586200 },
      })
    ).toThrow(/Rate-limited/);

    const parseSyn = createClaudeEventParser();
    expect(() =>
      parseSyn({
        type: 'assistant',
        message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] },
      })
    ).toThrow(/hit your limit/);
  });
});

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
