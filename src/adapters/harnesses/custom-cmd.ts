import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { spawnIsolated, withPhaseSandbox } from '../utils/spawn.js';

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function createCustomCmdAdapter(cmdTemplate: string): SpeedtestAdapter {
  return {
    id: 'cmd',
    name: 'Custom Command',
    category: 'custom',
    supportsToolLoop: false,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      const gen = await withPhaseSandbox<AdapterStreamChunk>(
        req.cwd,
        req.enableReadTool,
        async function* (effectiveCwd) {
        const quotedPrompt = shellQuote(req.prompt);
        const commandLine = cmdTemplate.includes('{prompt}')
          ? cmdTemplate.replaceAll('{prompt}', quotedPrompt)
          : `${cmdTemplate} ${quotedPrompt}`;

        const proc = spawnIsolated('sh', ['-c', commandLine], {
          cwd: effectiveCwd,
          signal: req.signal,
          env: { SPEEDTEST_PROMPT: req.prompt },
        });

        let emittedText = false;
        try {
          for await (const chunk of proc.child.stdout) {
            const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
            if (text.length > 0) {
              emittedText = true;
              yield { kind: 'text', text };
            }
          }

          const code = await proc.waitForExit();
          if (code !== 0 && !emittedText && !req.signal.aborted) {
            const tail = proc.getStderrTail();
            throw new Error(`custom command exited with code ${code}${tail ? `: ${tail}` : ''}`);
          }
        } finally {
          proc.cleanup();
        }
      });

      yield* gen;
    },
  };
}
