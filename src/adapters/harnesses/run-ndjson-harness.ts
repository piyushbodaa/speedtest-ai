import type { AdapterInvokeRequest, AdapterStreamChunk } from '../../types.js';
import { parseNdjsonStream } from '../utils/ndjson.js';
import { spawnIsolated, withPhaseSandbox } from '../utils/spawn.js';

export async function* runNdjsonHarness(options: {
  binaryPath: string;
  label: string;
  req: AdapterInvokeRequest;
  buildArgs: (effectiveCwd: string) => string[];
  createParser: () => (ev: unknown) => AdapterStreamChunk[];
}): AsyncGenerator<AdapterStreamChunk, void, unknown> {
  const gen = await withPhaseSandbox(
    options.req.cwd,
    options.req.enableReadTool,
    async function* (effectiveCwd) {
      const args = options.buildArgs(effectiveCwd);
      const proc = spawnIsolated(options.binaryPath, args, {
        cwd: effectiveCwd,
        signal: options.req.signal,
      });
      const parseEvent = options.createParser();
      let emittedText = false;

      try {
        for await (const ev of parseNdjsonStream(proc.child.stdout)) {
          for (const chunk of parseEvent(ev)) {
            if (chunk.kind === 'text' || chunk.kind === 'thinking') {
              emittedText = true;
            }
            yield chunk;
          }
        }
        const code = await proc.waitForExit();
        if (!emittedText) {
          const tail = proc.getStderrTail();
          const tailLine = tail ? tail.split('\n').slice(-2).join(' | ').trim() : '';
          if (options.req.signal.aborted) {
            const reason =
              options.req.signal.reason instanceof Error
                ? options.req.signal.reason.message
                : undefined;
            throw new Error(
              `${options.label} timed out before emitting tokens${tailLine ? `: ${tailLine}` : reason ? ` (${reason})` : ''}`
            );
          }
          throw new Error(
            `${options.label} exited (code ${code ?? 'killed'}) without emitting tokens${tailLine ? `: ${tailLine}` : ''}`
          );
        }
      } finally {
        proc.cleanup();
      }
    }
  );

  yield* gen;
}
