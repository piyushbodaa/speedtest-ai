import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runTextHarness } from './run-ndjson-harness.js';

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** `{prompt}` is replaced by the shell-quoted prompt; without it the prompt is appended. */
export function buildCustomCommandLine(cmdTemplate: string, prompt: string): string {
  const quotedPrompt = shellQuote(prompt);
  return cmdTemplate.includes('{prompt}')
    ? cmdTemplate.replaceAll('{prompt}', quotedPrompt)
    : `${cmdTemplate} ${quotedPrompt}`;
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
        buildArgs: () => ['-c', buildCustomCommandLine(cmdTemplate, req.prompt)],
        env: { SPEEDTEST_PROMPT: req.prompt },
      });
    },
  };
}
