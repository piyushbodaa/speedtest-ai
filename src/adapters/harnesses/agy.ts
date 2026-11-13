import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';
import { createFlexibleHarnessParser } from './shared-json-parser.js';

export const createAgyEventParser = createFlexibleHarnessParser;

export function createAgyAdapter(binaryPath = 'agy'): SpeedtestAdapter {
  return {
    id: 'agy',
    name: 'Antigravity CLI',
    category: 'harness',
    supportsToolLoop: true,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      yield* runNdjsonHarness({
        binaryPath,
        label: 'agy',
        req,
        createParser: createAgyEventParser,
        buildArgs: () => {
          const args = [
            '-p',
            req.prompt,
            '--output-format',
            'stream-json',
            '--disable-slash-commands',
          ];
          if (req.enableReadTool) {
            args.push('--dangerously-skip-permissions');
          }
          if (req.model && req.model !== 'default') {
            args.push('--model', req.model);
          }
          return args;
        },
      });
    },
  };
}
