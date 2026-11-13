import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';
import { createFlexibleHarnessParser } from './shared-json-parser.js';

export const createMuseEventParser = createFlexibleHarnessParser;

export function createMuseAdapter(binaryPath = 'muse'): SpeedtestAdapter {
  return {
    id: 'muse',
    name: 'Muse Code CLI',
    category: 'harness',
    supportsToolLoop: true,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      yield* runNdjsonHarness({
        binaryPath,
        label: 'muse',
        req,
        createParser: createMuseEventParser,
        buildArgs: (effectiveCwd) => [
          'exec',
          '--json',
          ...(req.enableReadTool ? ['--workspace', effectiveCwd] : ['--preset', 'empty']),
          ...(req.model && req.model !== 'default' ? ['--model', req.model] : []),
          '--',
          req.prompt,
        ],
      });
    },
  };
}
