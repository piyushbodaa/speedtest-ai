import { afterAll, describe, expect, it } from 'vitest';
import { buildCustomCommandLine, createCustomCmdAdapter } from '../src/adapters/harnesses/custom-cmd.js';
import { killAllChildren } from '../src/adapters/utils/spawn.js';
import { InterruptedError, isInterruptedError, isTargetFailedError } from '../src/core/errors.js';
import { collect, makeRequest, visibleText } from './helpers/replay-cli.js';

afterAll(() => {
  killAllChildren({ force: true });
});

describe('custom command line', () => {
  it('keeps each placeholder as an argument reference', () => {
    expect(buildCustomCommandLine('tool --ask {prompt} --again {prompt}')).toBe('tool --ask "$SPEEDTEST_PROMPT" --again "$SPEEDTEST_PROMPT"');
  });

  it('appends an argument reference when the template has no placeholder', () => {
    expect(buildCustomCommandLine('tool -p')).toBe('tool -p "$SPEEDTEST_PROMPT"');
  });
});

describe('custom command adapter', () => {
  it('is an experimental target without a tool loop', () => {
    expect(createCustomCmdAdapter('echo')).toMatchObject({
      id: 'cmd',
      category: 'custom',
      tier: 'experimental',
      supportsToolLoop: false,
    });
  });

  it('streams stdout as visible text and succeeds on exit code 0', async () => {
    const prompt = `quote ' and $HOME and "double" and $&`;
    const chunks = await collect(createCustomCmdAdapter('printf %s {prompt}').stream(makeRequest({ prompt })));

    expect(chunks[0].kind).toBe('start');
    expect(visibleText(chunks)).toBe(prompt);
    expect(chunks.some((c) => c.kind === 'terminal')).toBe(false);
  });

  it('exports the prompt as SPEEDTEST_PROMPT', async () => {
    const chunks = await collect(
      createCustomCmdAdapter('printf %s "$SPEEDTEST_PROMPT" #').stream(makeRequest({ prompt: 'from env' }))
    );
    expect(visibleText(chunks)).toBe('from env');
  });

  it('keeps a multi-byte character that is split across two writes', async () => {
    const cmd = `printf 'caf\\303'; sleep 0.2; printf '\\251 \\342\\202'; sleep 0.2; printf '\\254'; :`;
    const chunks = await collect(createCustomCmdAdapter(cmd).stream(makeRequest()));
    expect(visibleText(chunks)).toBe('café €');
  });

  it('fails on a non-zero exit even after partial output', async () => {
    const error = await collect(
      createCustomCmdAdapter('printf partial; echo boom >&2; exit 3; :').stream(makeRequest())
    ).catch((e) => e);

    expect(isTargetFailedError(error)).toBe(true);
    expect(error.exitCode).toBe(3);
    expect(error.message).toMatch(/custom command failed \(exit code 3\): boom/);
  });

  it('reports a missing program as a failure, not a crash', async () => {
    const error = await collect(
      createCustomCmdAdapter('speedtest-ai-no-such-program-xyz').stream(makeRequest())
    ).catch((e) => e);

    expect(isTargetFailedError(error)).toBe(true);
    expect(error.exitCode).toBe(127);
  });

  it('an interrupt stops the command and never yields a result', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new InterruptedError()), 300);

    const error = await collect(
      createCustomCmdAdapter('printf partial; sleep 30; :').stream(makeRequest({ signal: controller.signal }))
    ).catch((e) => e);

    expect(isInterruptedError(error)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
