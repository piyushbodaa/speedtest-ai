import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';
import { createFlexibleHarnessParser } from './shared-json-parser.js';

const DEFAULT_AGY_MODEL = 'gemini-4-carbon-low';

export function createAgyEventParser(): (ev: unknown) => AdapterStreamChunk[] {
  const fallbackParser = createFlexibleHarnessParser();
  let emittedAny = false;

  return (raw: unknown): AdapterStreamChunk[] => {
    if (!raw || typeof raw !== 'object') return [];
    const ev = raw as Record<string, any>;

    if (typeof ev.event === 'string') {
      const chunks: AdapterStreamChunk[] = [];

      if (ev.event === 'init') {
        chunks.push({
          kind: 'init',
          model: typeof ev.init?.model === 'string' ? ev.init.model : undefined,
        });
        return chunks;
      }

      if (ev.event === 'step_update' && ev.step_update && typeof ev.step_update === 'object') {
        const su = ev.step_update as Record<string, any>;
        if (
          typeof su.step_type === 'string' &&
          su.step_type !== 'user_input' &&
          su.step_type !== 'agent_response' &&
          su.state === 'ACTIVE'
        ) {
          chunks.push({ kind: 'tool_call', toolName: su.step_type });
        }
        if (typeof su.thinking_delta === 'string' && su.thinking_delta.length > 0) {
          emittedAny = true;
          chunks.push({ kind: 'thinking', text: su.thinking_delta });
        }
        if (typeof su.text_delta === 'string' && su.text_delta.length > 0) {
          emittedAny = true;
          chunks.push({ kind: 'text', text: su.text_delta });
        }
        return chunks;
      }

      if (ev.event === 'result' && ev.result && typeof ev.result === 'object') {
        const r = ev.result as Record<string, any>;
        if (r.status === 'ERROR') {
          throw new Error(
            typeof r.error === 'string' && r.error ? r.error : 'Antigravity CLI returned ERROR'
          );
        }
        if (!emittedAny && typeof r.response === 'string' && r.response.length > 0) {
          emittedAny = true;
          chunks.push({ kind: 'text', text: r.response });
        }
        if (r.usage && typeof r.usage === 'object') {
          const u = r.usage as Record<string, any>;
          const baseIn = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
          const cacheRead = typeof u.cache_read_tokens === 'number' ? u.cache_read_tokens : 0;
          const totalIn = baseIn + cacheRead;
          chunks.push({
            kind: 'usage',
            inputTokens: totalIn > 0 ? totalIn : undefined,
            cachedInputTokens: cacheRead > 0 ? cacheRead : undefined,
            outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
            apiDurationMs:
              typeof r.duration_seconds === 'number'
                ? Math.round(r.duration_seconds * 1000)
                : undefined,
          });
        }
        return chunks;
      }

      return chunks;
    }

    const fallback = fallbackParser(raw);
    for (const c of fallback) {
      if (c.kind === 'text' || c.kind === 'thinking') {
        emittedAny = true;
      }
    }
    return fallback;
  };
}

export function createAgyAdapter(binaryPath = 'agy'): SpeedtestAdapter {
  return {
    id: 'agy',
    name: 'Antigravity CLI',
    category: 'harness',
    supportsToolLoop: true,
    defaultModel: DEFAULT_AGY_MODEL,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      const effectiveModel = req.model && req.model !== 'default' ? req.model : DEFAULT_AGY_MODEL;
      yield* runNdjsonHarness({
        binaryPath,
        label: 'agy',
        req,
        createParser: createAgyEventParser,
        buildArgs: () => [
          '-p',
          req.prompt,
          '--output-format',
          'stream-json',
          '--disable-slash-commands',
          '--dangerously-skip-permissions',
          '--model',
          effectiveModel,
        ],
      });
    },
  };
}
