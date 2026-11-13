import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';
import { createFlexibleHarnessParser } from './shared-json-parser.js';

export function createGrokEventParser(): (ev: unknown) => AdapterStreamChunk[] {
  const fallbackParser = createFlexibleHarnessParser();

  return (raw: unknown): AdapterStreamChunk[] => {
    if (!raw || typeof raw !== 'object') return [];
    const ev = raw as Record<string, any>;

    if (ev.type === 'text' && typeof ev.data === 'string' && ev.data.length > 0) {
      return [{ kind: 'text', text: ev.data }];
    }
    if (ev.type === 'thought' && typeof ev.data === 'string' && ev.data.length > 0) {
      return [{ kind: 'thinking', text: ev.data }];
    }

    if (ev.type === 'stream_event' && ev.event && typeof ev.event === 'object') {
      const inner = ev.event as Record<string, any>;
      if (inner.type === 'message_start' && typeof inner.message?.model === 'string') {
        return [{ kind: 'init', model: inner.message.model }];
      }
      if (inner.type === 'message_delta' && inner.usage && typeof inner.usage === 'object') {
        const u = inner.usage as Record<string, any>;
        const baseIn = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
        const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
        const cacheCreate =
          typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
        const totalIn = baseIn + cacheRead + cacheCreate;
        return [
          {
            kind: 'usage',
            inputTokens: totalIn > 0 ? totalIn : undefined,
            cachedInputTokens: cacheRead > 0 ? cacheRead : undefined,
            outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
          },
        ];
      }
    }

    if (ev.type === 'result' && ev.is_error === true) {
      throw new Error(typeof ev.result === 'string' && ev.result ? ev.result : 'Grok CLI error');
    }

    return fallbackParser(raw);
  };
}

export function createGrokAdapter(binaryPath = 'grok'): SpeedtestAdapter {
  return {
    id: 'grok',
    name: 'Grok CLI',
    category: 'harness',
    supportsToolLoop: true,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      yield* runNdjsonHarness({
        binaryPath,
        label: 'grok',
        req,
        createParser: createGrokEventParser,
        buildArgs: () => {
          const args = [
            '-p',
            req.prompt,
            '--output-format',
            'streaming-messages-json',
            '--include-partial-messages',
            '--no-plan',
            '--no-subagents',
            '--reasoning-effort',
            'low',
          ];
          if (req.enableReadTool) {
            args.push('--permission-mode', 'bypassPermissions');
          } else {
            args.push('--tools', '');
          }
          if (req.model && req.model !== 'default') {
            args.push('-m', req.model);
          }
          return args;
        },
      });
    },
  };
}
