import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findHarnessEntry, HARNESS_CATALOG } from '../src/adapters/catalog.js';
import { AnsiStripper, createTextStreamAdapter } from '../src/adapters/harnesses/text-stream.js';
import { InterruptedError, isInterruptedError, isTargetFailedError } from '../src/core/errors.js';
import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../src/types.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-text-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function request(overrides: Partial<AdapterInvokeRequest> = {}): AdapterInvokeRequest {
  return { phase: 'download', prompt: 'say hi', signal: new AbortController().signal, ...overrides };
}

async function collect(adapter: SpeedtestAdapter, req = request()): Promise<AdapterStreamChunk[]> {
  const chunks: AdapterStreamChunk[] = [];
  for await (const chunk of adapter.stream(req)) chunks.push(chunk);
  return chunks;
}

const visible = (chunks: AdapterStreamChunk[]) =>
  chunks
    .filter((c) => c.kind === 'text')
    .map((c) => c.text)
    .join('');

describe('generic text-stream adapter', () => {
  it('turns incremental stdout into text chunks and succeeds on exit code 0', async () => {
    const bin = script('fake', 'printf "one "; sleep 0.15; printf "two "; sleep 0.15; printf "three\\n"');
    const adapter = createTextStreamAdapter({ id: 'fake', name: 'Fake', binaryPath: bin, buildArgs: () => [] });

    const chunks = await collect(adapter);

    expect(chunks[0]).toEqual({ kind: 'start' });
    expect(visible(chunks)).toBe('one two three\n');
    expect(chunks.filter((c) => c.kind === 'text').length).toBeGreaterThanOrEqual(3);
    expect(adapter).toMatchObject({ tier: 'experimental', category: 'harness', supportsToolLoop: false });
  });

  it('passes the prompt and the model through the entry-specific argument builder', async () => {
    const bin = script('fake', 'for a in "$@"; do printf "[%s]" "$a"; done');
    const adapter = createTextStreamAdapter({
      id: 'fake',
      name: 'Fake',
      binaryPath: bin,
      modelFlag: '--model',
      buildArgs: (ctx) => [...(ctx.model ? ['--model', ctx.model] : []), '--prompt', ctx.prompt],
    });

    const chunks = await collect(adapter, request({ prompt: "it's a 'quoted' $prompt", model: 'big-1' }));

    expect(visible(chunks)).toBe("[--model][big-1][--prompt][it's a 'quoted' $prompt]");
  });

  it('runs in an empty temporary directory, not the caller cwd', async () => {
    const bin = script('fake', 'pwd; ls -A | wc -l');
    const adapter = createTextStreamAdapter({ id: 'fake', name: 'Fake', binaryPath: bin, buildArgs: () => [] });

    const [cwd, count] = visible(await collect(adapter)).trim().split('\n');

    expect(cwd).not.toBe(process.cwd());
    expect(cwd).toContain('speedtest-ai-empty-');
    expect(count.trim()).toBe('0');
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it('fails with the stderr tail on a non-zero exit, even after partial output', async () => {
    const bin = script('fake', 'printf "partial answer"; echo "Not logged in. Please log in." >&2; exit 3');
    const adapter = createTextStreamAdapter({ id: 'fake', name: 'Fake', binaryPath: bin, buildArgs: () => [] });

    const error = await collect(adapter).catch((e) => e);

    expect(isTargetFailedError(error)).toBe(true);
    expect(error.message).toMatch(/fake failed \(exit code 3\): Not logged in/);
    expect(error.kind).toBe('auth');
  });

  it('fails when the CLI exits 0 without printing an answer', async () => {
    const bin = script('fake', 'printf "\\n  \\n"; exit 0');
    const adapter = createTextStreamAdapter({ id: 'fake', name: 'Fake', binaryPath: bin, buildArgs: () => [] });

    await expect(collect(adapter)).rejects.toThrow(/printed no answer/);
  });

  it('does not count leading blank output as the first token', async () => {
    const bin = script('fake', 'printf "\\n\\n"; sleep 0.2; printf "answer"');
    const adapter = createTextStreamAdapter({ id: 'fake', name: 'Fake', binaryPath: bin, buildArgs: () => [] });

    const texts = (await collect(adapter)).filter((c) => c.kind === 'text').map((c) => c.text);

    expect(texts[0]).toBe('answer');
  });

  it('strips terminal escapes, including one split across two chunks', async () => {
    const bin = script(
      'fake',
      'printf "\\033[1m> \\033[0mHello \\033[3"; sleep 0.2; printf "2mgreen\\033[0m world\\033]0;title\\007\\n"'
    );
    const adapter = createTextStreamAdapter({
      id: 'fake',
      name: 'Fake',
      binaryPath: bin,
      buildArgs: () => [],
      stripAnsi: true,
    });

    expect(visible(await collect(adapter))).toBe('> Hello green world\n');
  });

  it('rejects -m for a CLI without a usable model flag', async () => {
    const bin = script('fake', 'echo hi');
    const noFlag = createTextStreamAdapter({ id: 'fake', name: 'Fake', binaryPath: bin, buildArgs: () => [] });
    const notInHelp = createTextStreamAdapter({
      id: 'fake',
      name: 'Fake',
      binaryPath: bin,
      buildArgs: () => [],
      modelFlag: '--model',
      helpText: 'Usage: fake --prompt <text>',
    });

    for (const adapter of [noFlag, notInHelp]) {
      const error = await collect(adapter, request({ model: 'x' })).catch((e) => e);
      expect(isTargetFailedError(error)).toBe(true);
      expect(error.kind).toBe('model');
    }
  });

  it('reports a missing binary as a normal target failure', async () => {
    const adapter = createTextStreamAdapter({
      id: 'fake',
      name: 'Fake',
      binaryPath: path.join(dir, 'does-not-exist'),
      buildArgs: () => [],
    });

    const error = await collect(adapter).catch((e) => e);

    expect(isTargetFailedError(error)).toBe(true);
    expect(error.kind).toBe('not_found');
  });

  it('stops the CLI and throws the interrupt when the run is aborted', async () => {
    const bin = script('fake', 'printf "started"; sleep 30');
    const adapter = createTextStreamAdapter({ id: 'fake', name: 'Fake', binaryPath: bin, buildArgs: () => [] });
    const controller = new AbortController();
    const started = Date.now();

    const run = collect(adapter, request({ signal: controller.signal }));
    setTimeout(() => controller.abort(new InterruptedError()), 200);
    const error = await run.catch((e) => e);

    expect(isInterruptedError(error)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('AnsiStripper', () => {
  it('removes colour, cursor and title sequences and bare carriage returns', () => {
    const stripper = new AnsiStripper();
    expect(stripper.push('\u001b[2K\rloading\r\u001b[1;32mok\u001b[0m\r\n')).toBe('loadingok\r\n');
    expect(stripper.push('plain')).toBe('plain');
    expect(stripper.flush()).toBe('');
  });
});

describe('experimental catalog entries', () => {
  // Runs the catalog entry's adapter against a fake CLI that prints its own arguments.
  const argv = async (id: string, model?: string, help = ''): Promise<string[]> => {
    const bin = script(`argv-${id}`, 'for a in "$@"; do printf "%s\\n" "$a"; done');
    const adapter = findHarnessEntry(id)!.create!(bin, { helpText: help });
    const chunks = await collect(adapter, request({ prompt: 'PROMPT', model }));
    return visible(chunks).trim().split('\n');
  };

  it('builds the documented headless invocation for each text CLI', async () => {
    expect(await argv('gemini', 'g-pro', '--model --prompt')).toEqual(['--model', 'g-pro', '--prompt', 'PROMPT']);
    expect(await argv('qwen')).toEqual(['--prompt', 'PROMPT']);
    expect(await argv('opencode', 'a/b', '--model')).toEqual(['run', '--model', 'a/b', 'PROMPT']);
    expect(await argv('cursor-agent')).toEqual(['--print', '--output-format', 'text', 'PROMPT']);
    expect(await argv('amp')).toEqual(['--execute', 'PROMPT']);
    expect(await argv('crush')).toEqual(['run', '--quiet', 'PROMPT']);
    expect(await argv('kiro-cli')).toEqual(['chat', '--no-interactive', 'PROMPT']);
    expect(await argv('droid')).toEqual(['exec', '--output-format', 'text', 'PROMPT']);
  });

  it('adds optional flags only when the CLI help lists them', async () => {
    expect(await argv('copilot', undefined, '--prompt')).toEqual(['--prompt', 'PROMPT']);
    expect(await argv('copilot', undefined, '--prompt --silent')).toEqual(['--silent', '--prompt', 'PROMPT']);
    expect(await argv('pi', undefined, '--print --no-session')).toEqual(['--print', '--no-session', 'PROMPT']);
    expect(await argv('goose', undefined, '--text --no-session')).toEqual(['run', '--no-session', '--text', 'PROMPT']);
    expect(await argv('goose', undefined, '--text --no-session --quiet')).toEqual([
      'run',
      '--no-session',
      '--quiet',
      '--text',
      'PROMPT',
    ]);
  });

  it('never passes a flag that approves tool use or skips permissions', async () => {
    for (const entry of HARNESS_CATALOG.filter((e) => e.tier === 'experimental' && e.create)) {
      const args = await argv(entry.id, undefined, '--yolo --force --allow-all-tools --dangerously-skip-permissions');
      expect(args.join(' ')).not.toMatch(/yolo|force|allow-all|skip-permissions|trust-all|auto/);
    }
  });
});
