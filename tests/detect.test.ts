import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  explainAllSkips,
  findHarnessEntry,
  HARNESS_CATALOG,
  knownTargetIds,
  PROVIDER_CATALOG,
  selectAllTargets,
  targetsHelpLines,
} from '../src/adapters/catalog.js';
import { resolveAdapter } from '../src/adapters/registry.js';
import {
  buildSafeEnv,
  detectTargets,
  inspectHarness,
  resolveBinary,
  resolveRealBinary,
  runCapture,
} from '../src/core/detect.js';
import { isTargetFailedError } from '../src/core/errors.js';
import type { TargetInfo } from '../src/types.js';
import { createFakeMachine, type FakeMachine, fakeCliScript } from './helpers/fake-path.js';

let machine: FakeMachine;

beforeEach(() => {
  machine = createFakeMachine();
});

afterEach(() => {
  machine.remove();
});

const joinPath = (...dirs: string[]) => dirs.join(path.delimiter);

describe('buildSafeEnv', () => {
  it('disables mise auto-install and strips the Claude Code session markers', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    try {
      const safe = buildSafeEnv();
      expect(safe.MISE_AUTO_INSTALL).toBe('false');
      expect(safe.MISE_NOT_FOUND_AUTO_INSTALL).toBe('0');
      expect(safe.CLAUDECODE).toBeUndefined();
      expect(safe.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    }
  });
});

describe('runCapture', () => {
  it('reports a missing binary without rejecting', async () => {
    const result = await runCapture(path.join(machine.root, 'nope'), ['--version'], { timeoutMs: 500 });
    expect(result.failed).toBe(true);
  });

  it('kills a command that outlives its timeout', async () => {
    const slow = machine.addScript(machine.realDir, 'slow', 'echo started\nsleep 30');
    const started = Date.now();
    const result = await runCapture(slow, [], { timeoutMs: 250 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('binary resolution with mise shims', () => {
  it('skips a command wrapper and a shim and keeps scanning to the real binary', async () => {
    machine.addWrapper('mytool');
    machine.addShim('mytool');
    const real = machine.addScript(machine.realDir, 'mytool', 'echo real');

    const resolution = await resolveBinary('mytool', {
      pathEnv: joinPath(machine.wrapperDir, machine.realDir, machine.shimDir),
    });

    expect(resolution).toMatchObject({ status: 'found', path: real });
    // The real binary was on PATH, so mise was never consulted, let alone a shim executed.
    expect(machine.readLog()).toBe('');
  });

  it('asks `mise which` only when the scan found nothing but shims', async () => {
    machine.addShim('mytool');
    const installed = machine.addScript(path.join(machine.installsDir, 'mytool', 'latest'), 'mytool', 'echo real');
    machine.activate('mytool', installed);

    const resolution = await resolveBinary('mytool', { pathEnv: joinPath(machine.shimDir) });

    expect(resolution).toMatchObject({ status: 'found', path: installed });
    const log = machine.readLog().trim().split('\n');
    expect(log).toEqual([`${machine.miseBin} which mytool`]);
  });

  it('treats a shim that mise calls "not currently active" as not installed, without running it', async () => {
    const shim = machine.addShim('lazytool');

    const resolution = await resolveBinary('lazytool', { pathEnv: joinPath(machine.shimDir) });

    expect(resolution).toMatchObject({ status: 'shim_inactive', path: null, shimPath: shim });
    expect(await resolveRealBinary('lazytool', joinPath(machine.shimDir))).toBeNull();
    for (const line of machine.readLog().trim().split('\n')) {
      expect(line.startsWith(`${machine.miseBin} which `)).toBe(true);
    }
  });

  it('never accepts a shim path that `mise which` hands back', async () => {
    const shim = machine.addShim('looptool');
    machine.activate('looptool', shim);

    const resolution = await resolveBinary('looptool', { pathEnv: joinPath(machine.shimDir) });

    expect(resolution.status).toBe('shim_inactive');
    expect(resolution.path).toBeNull();
  });

  it('recognises a script shim by its directory and reports it unresolved when mise is absent', async () => {
    const shim = machine.addScript(machine.shimDir, 'scripttool', 'echo SHIM-RAN >> "$0.ran"\nexit 1');

    const resolution = await resolveBinary('scripttool', { pathEnv: joinPath(machine.shimDir) });

    expect(resolution).toMatchObject({ status: 'shim_unresolved', path: null, shimPath: shim });
    expect(resolution.detail).toMatch(/mise itself was not found/);
  });

  it('gives up on a hanging mise within the timeout', async () => {
    machine.addShim('mytool');
    machine.hangMise();
    const started = Date.now();

    const resolution = await resolveBinary('mytool', { pathEnv: joinPath(machine.shimDir), miseTimeoutMs: 300 });

    expect(resolution.status).toBe('shim_unresolved');
    expect(resolution.detail).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('returns missing for a command that is nowhere on PATH', async () => {
    expect(await resolveBinary('definitely-missing-binary-xyz', { pathEnv: machine.realDir })).toEqual({
      status: 'missing',
      path: null,
    });
  });
});

describe('capability and auth probes', () => {
  const gemini = () => findHarnessEntry('gemini')!;

  it('marks an experimental CLI runnable when its help lists the flags the adapter needs', async () => {
    const bin = machine.addScript(
      machine.realDir,
      'gemini',
      fakeCliScript({ version: 'gemini 9.9.9', help: 'Usage: gemini\n  -p, --prompt  Prompt\n  -m, --model  Model' })
    );

    const info = await inspectHarness(gemini(), { pathEnv: machine.realDir });

    expect(info).toMatchObject({
      id: 'gemini',
      available: true,
      runnable: true,
      tier: 'experimental',
      state: 'ready',
      binaryPath: bin,
      version: 'gemini 9.9.9',
    });
  });

  it('lists a CLI whose help lacks a required flag as installed but not supported', async () => {
    machine.addScript(machine.realDir, 'gemini', fakeCliScript({ help: 'Usage: gemini [query]\n  --model  Model' }));

    const info = await inspectHarness(gemini(), { pathEnv: machine.realDir });

    expect(info).toMatchObject({ available: true, runnable: false, state: 'unsupported' });
    expect(info.reason).toContain('--prompt');
  });

  it('does not mark a CLI runnable when its help never answers', async () => {
    machine.addScript(machine.realDir, 'gemini', 'sleep 30');

    const info = await inspectHarness(gemini(), { pathEnv: machine.realDir, probeTimeoutMs: 300 });

    expect(info).toMatchObject({ available: true, runnable: false, state: 'unsupported' });
  });

  it('keeps a detect-only CLI out of the runnable set', async () => {
    machine.addScript(machine.realDir, 'aider', fakeCliScript({ version: 'aider 0.99' }));

    const info = await inspectHarness(findHarnessEntry('aider')!, { pathEnv: machine.realDir });

    expect(info).toMatchObject({ available: true, runnable: false, state: 'unsupported', version: 'aider 0.99' });
    expect(info.reason).toMatch(/not supported yet/);
  });

  it('claims "logged out" only from the verified claude and codex probes', async () => {
    machine.addScript(
      machine.realDir,
      'claude',
      'if [ "$1" = "auth" ]; then echo \'{"loggedIn": false}\'; exit 1; fi\necho "2.0.0 (Claude Code)"'
    );
    machine.addScript(
      machine.realDir,
      'codex',
      'if [ "$1" = "login" ]; then echo "Not logged in" >&2; exit 1; fi\necho "codex-cli 1.0.0"'
    );
    machine.addScript(machine.realDir, 'grok', 'echo "Please log in" >&2; exit 1');

    const [claude, codex, grok] = await Promise.all(
      ['claude', 'codex', 'grok'].map((id) => inspectHarness(findHarnessEntry(id)!, { pathEnv: machine.realDir }))
    );

    expect(claude).toMatchObject({ runnable: true, authState: 'logged_out', state: 'logged_out' });
    expect(claude.reason).toContain('claude auth login');
    expect(codex).toMatchObject({ runnable: true, authState: 'logged_out', loginHint: 'codex login' });
    expect(grok).toMatchObject({ runnable: true, authState: 'unknown', state: 'ready' });
  });

  it('reports auth as unknown when the status output is not understood', async () => {
    machine.addScript(machine.realDir, 'claude', 'echo "something else entirely"');

    const info = await inspectHarness(findHarnessEntry('claude')!, { pathEnv: machine.realDir });

    expect(info).toMatchObject({ runnable: true, authState: 'unknown', state: 'ready' });
  });

  it('accepts a logged-in claude and codex', async () => {
    machine.addScript(
      machine.realDir,
      'claude',
      'if [ "$1" = "auth" ]; then echo \'{"loggedIn": true, "authMethod": "claude.ai"}\'; exit 0; fi\necho 2.0.0'
    );
    machine.addScript(
      machine.realDir,
      'codex',
      'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi\necho 1.0.0'
    );

    const claude = await inspectHarness(findHarnessEntry('claude')!, { pathEnv: machine.realDir });
    const codex = await inspectHarness(findHarnessEntry('codex')!, { pathEnv: machine.realDir });

    expect(claude.authState).toBe('ready');
    expect(codex.authState).toBe('ready');
  });
});

describe('detectTargets', () => {
  it('reports every catalog row once, with shims as not installed and nothing executed through mise', async () => {
    machine.addWrapper('claude');
    machine.addShim('claude');
    machine.addScript(path.join(machine.installsDir, 'claude', 'latest'), 'claude', 'echo "2.1.0 (Claude Code)"');
    machine.addShim('opencode');
    machine.addShim('devin');

    const targets = await detectTargets({
      pathEnv: joinPath(machine.wrapperDir, path.join(machine.installsDir, 'claude', 'latest'), machine.shimDir),
      env: {},
      probeLocal: false,
    });

    const ids = targets.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...HARNESS_CATALOG.map((e) => e.id), ...PROVIDER_CATALOG.map((e) => e.id), 'demo']);

    const byId = new Map(targets.map((t) => [t.id, t]));
    expect(byId.get('claude')).toMatchObject({
      available: true,
      runnable: true,
      tier: 'verified',
      binaryPath: path.join(machine.installsDir, 'claude', 'latest', 'claude'),
    });
    expect(byId.get('opencode')).toMatchObject({ available: false, runnable: false, state: 'not_installed' });
    expect(byId.get('opencode')?.reason).toMatch(/mise shim present/);
    expect(byId.get('devin')).toMatchObject({ available: false, runnable: false });
    expect(byId.get('codex')).toMatchObject({ available: false, reason: 'not installed' });
    expect(byId.get('openai')).toMatchObject({ available: false, runnable: false });
    expect(byId.get('demo')).toMatchObject({ available: true, runnable: true });

    const log = machine.readLog().trim().split('\n').filter(Boolean);
    expect(log.sort()).toEqual([`${machine.miseBin} which devin`, `${machine.miseBin} which opencode`]);
  });

  it('finishes quickly on the real machine and always offers the demo', async () => {
    const started = Date.now();
    const targets = await detectTargets();
    expect(Date.now() - started).toBeLessThan(8000);
    expect(targets.find((t) => t.id === 'demo')?.available).toBe(true);
    for (const target of targets) {
      if (target.binaryPath) expect(target.binaryPath).not.toMatch(/\/mise\/(shims|command-wrappers)\//);
      if (target.runnable) expect(target.available).toBe(true);
    }
  });
});

function target(partial: Partial<TargetInfo> & { id: string }): TargetInfo {
  return {
    name: partial.id,
    category: 'harness',
    available: true,
    runnable: true,
    tier: 'verified',
    authState: 'unknown',
    supportsToolLoop: false,
    ...partial,
  };
}

describe('selecting the targets of "all"', () => {
  const detected: TargetInfo[] = [
    target({ id: 'claude', authState: 'ready' }),
    target({ id: 'codex', authState: 'logged_out', reason: 'not logged in (run: codex login)' }),
    target({ id: 'gemini', tier: 'experimental' }),
    target({ id: 'aider', tier: 'experimental', runnable: false, reason: 'installed, not supported yet' }),
    target({ id: 'opencode', tier: 'experimental', available: false, runnable: false }),
    target({ id: 'ollama', category: 'local' }),
    target({ id: 'lmstudio', category: 'local', available: false, runnable: false }),
    target({ id: 'openai', category: 'provider' }),
    target({ id: 'demo', category: 'demo' }),
  ];

  it('takes runnable agent CLIs and running local runtimes, never cloud APIs or the demo', () => {
    expect(selectAllTargets(detected).map((t) => t.id)).toEqual(['claude', 'gemini', 'ollama']);
  });

  it('adds cloud API providers only with includeApis', () => {
    expect(selectAllTargets(detected, { includeApis: true }).map((t) => t.id)).toEqual([
      'claude',
      'gemini',
      'ollama',
      'openai',
    ]);
  });

  it('explains what was left out, for installed targets only', () => {
    expect(explainAllSkips(detected)).toEqual([
      { id: 'codex', name: 'codex', reason: 'not logged in (run: codex login)' },
      { id: 'aider', name: 'aider', reason: 'installed, not supported yet' },
      { id: 'openai', name: 'openai', reason: 'cloud API targets are only benchmarked with --include-apis' },
    ]);
  });

  it('returns nothing when no CLI is installed, so the caller can exit with code 2', () => {
    expect(selectAllTargets([target({ id: 'demo', category: 'demo' })])).toEqual([]);
  });
});

describe('catalog', () => {
  it('has unique ids and a complete entry for every runnable CLI', () => {
    const ids = knownTargetIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of HARNESS_CATALOG) {
      expect(entry.commands.length).toBeGreaterThan(0);
      if (entry.tier === 'verified') expect(entry.create).toBeTypeOf('function');
      // Nothing experimental may run without its flags being confirmed in the CLI's own help.
      if (entry.tier === 'experimental' && entry.create) {
        expect(entry.capability?.requires.length).toBeGreaterThan(0);
      }
      if (!entry.create) expect(entry.unsupportedReason).toBeTruthy();
    }
    expect(HARNESS_CATALOG.filter((e) => e.tier === 'verified').map((e) => e.id)).toEqual([
      'claude',
      'codex',
      'agy',
      'grok',
      'muse',
    ]);
  });

  it('renders the help block within 80 columns', () => {
    const lines = targetsHelpLines(80);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    const text = lines.join('\n');
    for (const id of ['claude', 'gemini', 'cursor-agent', 'aider', 'ollama:<model>', 'demo:frontier']) {
      expect(text).toContain(id);
    }
  });
});

describe('resolveAdapter', () => {
  it('refuses to fall back to a shim when the tool is not installed', async () => {
    machine.addShim('codex');

    const error = await resolveAdapter({ targetSpec: 'codex', pathEnv: machine.shimDir }).catch((e) => e);

    expect(isTargetFailedError(error)).toBe(true);
    expect(error.kind).toBe('not_found');
    expect(error.message).toMatch(/codex: not installed \(mise shim present/);
    expect(machine.readLog()).not.toMatch(/shims\/codex/);
  });

  it('builds a verified adapter on the real binary behind a command wrapper', async () => {
    machine.addWrapper('claude');
    machine.addScript(machine.realDir, 'claude', 'echo 2.0.0');

    const resolved = await resolveAdapter({
      targetSpec: 'claude:sonnet',
      pathEnv: joinPath(machine.wrapperDir, machine.realDir),
    });

    expect(resolved).toMatchObject({ model: 'sonnet', tier: 'verified' });
    expect(resolved.adapter).toMatchObject({ id: 'claude', tier: 'verified' });
  });

  it('leaves the model unset for an agent CLI unless the user named one', async () => {
    machine.addScript(machine.realDir, 'claude', 'echo 2.0.0');
    const resolved = await resolveAdapter({ targetSpec: 'claude', pathEnv: machine.realDir });
    expect(resolved.model).toBeUndefined();
  });

  it('gates an experimental adapter behind the help probe', async () => {
    machine.addScript(machine.realDir, 'qwen', fakeCliScript({ help: 'Usage: qwen [query]' }));
    machine.addScript(
      machine.realDir,
      'gemini',
      fakeCliScript({ help: '  -p, --prompt <text>\n  -m, --model <name>' })
    );

    const rejected = await resolveAdapter({ targetSpec: 'qwen', pathEnv: machine.realDir }).catch((e) => e);
    expect(isTargetFailedError(rejected)).toBe(true);
    expect(rejected.message).toMatch(/qwen: installed, not supported yet/);

    const accepted = await resolveAdapter({ targetSpec: 'gemini', pathEnv: machine.realDir });
    expect(accepted).toMatchObject({ tier: 'experimental' });
    expect(accepted.adapter).toMatchObject({ id: 'gemini', tier: 'experimental', supportsToolLoop: false });
  });

  it('rejects a detect-only CLI and an unknown target with a clear message', async () => {
    machine.addScript(machine.realDir, 'aider', 'echo 0.99');

    const aider = await resolveAdapter({ targetSpec: 'aider', pathEnv: machine.realDir }).catch((e) => e);
    expect(aider.message).toMatch(/aider: installed, not supported yet/);

    const unknown = await resolveAdapter({ targetSpec: 'nonsense' }).catch((e) => e);
    expect(unknown.message).toMatch(/Unknown target "nonsense"/);
  });

  it('points a missing gemini CLI at the renamed API target', async () => {
    const error = await resolveAdapter({ targetSpec: 'gemini', pathEnv: machine.realDir }).catch((e) => e);
    expect(error.message).toMatch(/gemini: not installed.*gemini-api/);
  });

  it('resolves providers, the demo and the custom command from the same table', async () => {
    const openai = await resolveAdapter({ targetSpec: 'openai:gpt-test', apiKey: 'k' });
    expect(openai).toMatchObject({ model: 'gpt-test', adapter: { id: 'openai', category: 'provider' } });

    const geminiApi = await resolveAdapter({ targetSpec: 'gemini-api', apiKey: 'k' });
    expect(geminiApi.adapter).toMatchObject({ id: 'gemini-api', category: 'provider' });

    const demo = await resolveAdapter({ targetSpec: 'demo' });
    expect(demo).toMatchObject({ model: 'frontier', adapter: { id: 'demo' } });
    await expect(resolveAdapter({ targetSpec: 'demo:warp' })).rejects.toThrow(/Unknown demo profile/);

    await expect(resolveAdapter({ targetSpec: 'cmd' })).rejects.toThrow(/requires --cmd/);
    const cmd = await resolveAdapter({ targetSpec: 'cmd', cmd: 'echo hi' });
    expect(cmd.adapter.id).toBe('cmd');
  });
});
