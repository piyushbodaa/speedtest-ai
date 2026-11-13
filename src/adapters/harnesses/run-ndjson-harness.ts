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
        if (code !== 0 && !emittedText && !options.req.signal.aborted) {
          const tail = proc.getStderrTail();
          throw new Error(`${options.label} exited with code ${code}${tail ? `: ${tail}` : ''}`);
        }
      } finally {
        proc.cleanup();
      }
    }
  );

  yield* gen;
}
