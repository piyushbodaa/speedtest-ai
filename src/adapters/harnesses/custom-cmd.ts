import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runTextHarness } from './run-ndjson-harness.js';

/** The prompt travels in the child environment, separate from the command's source. */
export function buildCustomCommandLine(cmdTemplate: string): string {
  return cmdTemplate.includes('{prompt}')
    ? cmdTemplate.replaceAll('{prompt}', '"$SPEEDTEST_PROMPT"')
    : cmdTemplate + ' "$SPEEDTEST_PROMPT"';
}

/**
 * A user-supplied shell command: raw stdout is the visible text and exit code 0 is success
 * (there is no terminal event to wait for). The prompt is also exported as SPEEDTEST_PROMPT.
 */
export function createCustomCmdAdapter(cmdTemplate: string): SpeedtestAdapter {
  return {
    id: 'cmd',
    name: 'Custom Command',
    category: 'custom',
    tier: 'experimental',
    supportsToolLoop: false,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      yield* runTextHarness({
        binaryPath: 'sh',
        label: 'custom command',
        req,
        buildArgs: () => ['-c', buildCustomCommandLine(cmdTemplate)],
        env: { SPEEDTEST_PROMPT: req.prompt },
      });
    },
  };
}
