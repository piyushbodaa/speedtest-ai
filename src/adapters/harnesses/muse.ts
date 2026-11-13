import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';
import { createFlexibleHarnessParser } from './shared-json-parser.js';

const DEFAULT_MUSE_MODEL = 'muse-spark-1.3';

export function createMuseEventParser(): (ev: unknown) => AdapterStreamChunk[] {
  const fallbackParser = createFlexibleHarnessParser();

  return (raw: unknown): AdapterStreamChunk[] => {
    if (!raw || typeof raw !== 'object') return [];
    const ev = raw as Record<string, any>;

    if (typeof ev.payload_type === 'string' && ev.payload && typeof ev.payload === 'object') {
      const p = ev.payload as Record<string, any>;
      if (ev.payload_type === 'run.model.configured') {
        const model =
          typeof p.model_id === 'string'
            ? p.model_id
            : typeof p.display_label === 'string'
              ? p.display_label
              : undefined;
        return [{ kind: 'init', model }];
      }

      if (ev.payload_type === 'run.output.delta' && typeof p.text === 'string' && p.text.length > 0) {
        return [{ kind: 'text', text: p.text }];
      }

      if (ev.payload_type === 'run.reasoning.delta' || ev.payload_type === 'run.thinking.delta') {
        const text = typeof p.text === 'string' ? p.text : typeof p.thinking === 'string' ? p.thinking : '';
        if (text.length > 0) {
          return [{ kind: 'thinking', text }];
        }
        return [];
      }

      if (ev.payload_type === 'task.lifecycle.proposed') {
        const taskKind = p.event?.task_kind;
        if (
          typeof taskKind === 'string' &&
          !taskKind.startsWith('model.') &&
          !taskKind.startsWith('reminder.')
        ) {
          return [{ kind: 'tool_call', toolName: taskKind }];
        }
        return [];
      }

      if (ev.payload_type === 'task.lifecycle.status' && Array.isArray(p.event?.details?.facets)) {
        for (const facet of p.event.details.facets) {
          if (typeof facet?.detail?.model === 'string') {
            return [{ kind: 'usage', model: facet.detail.model }];
          }
        }
        return [];
      }

      return [];
    }

    return fallbackParser(raw);
  };
}

export function createMuseAdapter(binaryPath = 'muse'): SpeedtestAdapter {
  return {
    id: 'muse',
    name: 'Muse Code CLI',
    category: 'harness',
    supportsToolLoop: true,
    defaultModel: DEFAULT_MUSE_MODEL,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      const effectiveModel = req.model && req.model !== 'default' ? req.model : DEFAULT_MUSE_MODEL;
      yield* runNdjsonHarness({
        binaryPath,
        label: 'muse',
        req,
        createParser: createMuseEventParser,
        buildArgs: (effectiveCwd) => [
          'exec',
          '--json',
          '--reasoning-effort',
          'low',
          ...(req.enableReadTool ? ['--workspace', effectiveCwd] : ['--preset', 'empty']),
          '--model',
          effectiveModel,
          '--',
          req.prompt,
        ],
      });
    },
  };
}
