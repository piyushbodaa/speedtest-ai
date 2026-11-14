import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterInvokeRequest, AdapterStreamChunk } from '../../src/types.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixturePath(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

/** The events of a sanitized real capture (tests/fixtures/*.jsonl). */
export function loadFixture(name: string): unknown[] {
  return fs
    .readFileSync(fixturePath(name), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export interface ReplayBin {
  dir: string;
  /**
   * Writes an executable `sh` script that stands in for a real CLI binary. `$FIXTURES` is the
   * fixture directory. Every invocation appends its arguments, joined by spaces, to a log.
   */
  script: (name: string, body: string) => string;
  /** One entry per invocation of the named script. */
  invocations: (name: string) => string[];
  remove: () => void;
}

export function createReplayBin(): ReplayBin {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-replay-'));
  const logOf = (name: string) => path.join(dir, `${name}.log`);
  return {
    dir,
    script: (name, body) => {
      const file = path.join(dir, name);
      fs.writeFileSync(
        file,
        `#!/bin/sh\nFIXTURES='${FIXTURE_DIR}'\necho "$*" >> '${logOf(name)}'\n${body}\n`,
        { mode: 0o755 }
      );
      return file;
    },
    invocations: (name) => {
      try {
        return fs.readFileSync(logOf(name), 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export function makeRequest(overrides: Partial<AdapterInvokeRequest> = {}): AdapterInvokeRequest {
  return {
    phase: 'download',
    prompt: 'say something',
    signal: new AbortController().signal,
    ...overrides,
  };
}

export async function collect(
  stream: AsyncGenerator<AdapterStreamChunk, void, unknown>
): Promise<AdapterStreamChunk[]> {
  const chunks: AdapterStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

export function visibleText(chunks: AdapterStreamChunk[]): string {
  return chunks
    .filter((c) => c.kind === 'text')
    .map((c) => c.text)
    .join('');
}
