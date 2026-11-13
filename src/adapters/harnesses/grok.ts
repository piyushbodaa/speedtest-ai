import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';
import { createFlexibleHarnessParser } from './shared-json-parser.js';

export const createGrokEventParser = createFlexibleHarnessParser;

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
            'streaming-json',
            '--include-partial-messages',
            '--no-plan',
            '--no-subagents',
            req.enableReadTool ? '--permission-mode=bypassPermissions' : '--tools=',
          ];
          if (req.model && req.model !== 'default') {
            args.push('-m', req.model);
          }
          return args;
        },
      });
    },
  };
}
