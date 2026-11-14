import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CARD_PATH,
  normalizeOptionalCardFlag,
  parseCliArgs,
  UsageError,
  type ParsedCommand,
} from '../src/cli-args.js';
import { DEFAULT_PHASE_TIMEOUT_MS, MAX_RUNS } from '../src/core/runner.js';

function parse(...argv: string[]): ParsedCommand {
  return parseCliArgs(argv);
}

function runOf(command: ParsedCommand) {
  if (command.kind === 'run' || command.kind === 'compare' || command.kind === 'all' || command.kind === 'default') {
    return command.run;
  }
  throw new Error(`no run options on ${command.kind}`);
}

function usageError(...argv: string[]): string {
  try {
    parseCliArgs(argv);
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return (err as Error).message;
  }
  throw new Error(`expected a usage error for: ${argv.join(' ')}`);
}

describe('commands', () => {
  it('parses run with a target, model and defaults', () => {
    const command = parse('run', '-t', 'claude', '-m', 'sonnet');
    expect(command).toMatchObject({ kind: 'run', targetSpec: 'claude' });
    expect(runOf(command)).toMatchObject({
      mode: undefined,
      timeoutMs: DEFAULT_PHASE_TIMEOUT_MS,
      runs: 1,
      asConfigured: false,
      noHistory: false,
      output: 'tui',
      model: 'sonnet',
      cardPath: undefined,
    });
  });

  it('treats -t without a command as run, and --cmd as the cmd target', () => {
    expect(parse('-t', 'ollama:llama3.2', '--quick')).toMatchObject({ kind: 'run', targetSpec: 'ollama:llama3.2' });
    expect(parse('--cmd', 'my-agent {prompt}')).toMatchObject({ kind: 'run', targetSpec: 'cmd' });
    expect(parse('--base-url', 'http://localhost:8080/v1')).toMatchObject({ kind: 'run', targetSpec: 'custom' });
  });

  it('maps demo to the demo target with a validated profile', () => {
    expect(parse('demo')).toMatchObject({ kind: 'run', targetSpec: 'demo:frontier' });
    expect(parse('demo', '--profile', 'flash')).toMatchObject({ kind: 'run', targetSpec: 'demo:flash' });
    expect(parse('demo', '-m', 'buffered')).toMatchObject({ kind: 'run', targetSpec: 'demo:buffered' });
    expect(runOf(parse('demo', '-m', 'local')).model).toBeUndefined();
  });

  it('parses all in its three spellings', () => {
    expect(parse('all')).toMatchObject({ kind: 'all', includeApis: false });
    expect(parse('-a', '--include-apis')).toMatchObject({ kind: 'all', includeApis: true });
    expect(parse('run', '-t', 'all', '--full')).toMatchObject({ kind: 'all' });
    expect(parse('-t', 'ALL')).toMatchObject({ kind: 'all' });
  });

  it('parses compare targets', () => {
    expect(parse('compare', '-t', 'claude, codex:gpt-5 ,demo:flash')).toMatchObject({
      kind: 'compare',
      specs: ['claude', 'codex:gpt-5', 'demo:flash'],
    });
  });

  it('parses detect, history, help and version', () => {
    expect(parse('detect')).toEqual({ kind: 'detect', json: false });
    expect(parse('detect', '--json')).toEqual({ kind: 'detect', json: true });
    expect(parse('history')).toEqual({ kind: 'history', json: false, limit: 15, clear: false });
    expect(parse('history', '--limit', '3', '--json')).toEqual({ kind: 'history', json: true, limit: 3, clear: false });
    expect(parse('history', '--clear')).toMatchObject({ kind: 'history', clear: true });
    expect(parse('--help')).toEqual({ kind: 'help' });
    expect(parse('help')).toEqual({ kind: 'help' });
    expect(parse('-v')).toEqual({ kind: 'version' });
  });

  it('falls back to the default command with no arguments', () => {
    expect(parse()).toMatchObject({ kind: 'default' });
    expect(runOf(parse('--full')).mode).toBe('full');
  });
});

describe('flags', () => {
  it('reads the new flags', () => {
    const run = runOf(parse('all', '--runs', '3', '--as-configured', '--standard', '--no-history', '--plain', '--timeout', '45'));
    expect(run).toMatchObject({
      runs: 3,
      asConfigured: true,
      mode: 'standard',
      noHistory: true,
      output: 'plain',
      timeoutMs: 45_000,
    });
    expect(runOf(parse('demo', '--runs', String(MAX_RUNS))).runs).toBe(MAX_RUNS);
    expect(runOf(parse('demo', '--timeout', '0.5')).timeoutMs).toBe(500);
  });

  it('picks the output mode', () => {
    expect(runOf(parse('demo', '--json')).output).toBe('json');
    expect(runOf(parse('demo', '--jsonl')).output).toBe('jsonl');
    expect(runOf(parse('demo', '--json', '--plain')).output).toBe('json');
  });

  it('gives --card a path only when the next token looks like one', () => {
    expect(runOf(parse('--card', 'demo', '--quick')).cardPath).toBe(DEFAULT_CARD_PATH);
    expect(parse('--card', 'demo', '--quick')).toMatchObject({ kind: 'run', targetSpec: 'demo:frontier' });
    expect(runOf(parse('demo', '--card')).cardPath).toBe(DEFAULT_CARD_PATH);
    expect(runOf(parse('demo', '--card', 'out.svg')).cardPath).toBe('out.svg');
    expect(runOf(parse('demo', '--card', 'OUT.SVG')).cardPath).toBe('OUT.SVG');
    expect(runOf(parse('demo', '--card', 'cards/claude')).cardPath).toBe('cards/claude');
    expect(runOf(parse('demo', '--card', '--quick')).cardPath).toBe(DEFAULT_CARD_PATH);
    expect(runOf(parse('demo', '--card=my card.svg')).cardPath).toBe('my card.svg');
    expect(normalizeOptionalCardFlag(['--card', 'run', '-t', 'x'])).toEqual([`--card=${DEFAULT_CARD_PATH}`, 'run', '-t', 'x']);
  });
});

describe('rejected command lines', () => {
  it('rejects unknown flags and commands', () => {
    expect(usageError('--bogus')).toBe("Unknown option '--bogus'.");
    expect(usageError('demo', '-x')).toContain("Unknown option '-x'");
    expect(usageError('frobnicate')).toContain('Unknown command "frobnicate"');
    expect(usageError('demo', 'extra', 'junk')).toContain('Unexpected argument "extra"');
  });

  it('rejects missing values', () => {
    expect(usageError('run', '-t')).toContain('needs a value');
    expect(usageError('demo', '--timeout')).toContain('--timeout needs a value');
    expect(usageError('demo', '--timeout', '--quick')).toContain('--timeout needs a value');
    expect(usageError('run', '-t', '')).toContain('--target expects a value');
    expect(usageError('run')).toContain('run needs a target');
    expect(usageError('compare')).toContain('compare needs -t');
    expect(usageError('compare', '-t', ' , ')).toContain('at least one target');
    expect(usageError('run', '-t', 'cmd')).toContain('needs --cmd');
    expect(usageError('demo', '--card=')).toContain('--card expects a file path');
  });

  it('rejects conflicting modes and outputs', () => {
    expect(usageError('demo', '--quick', '--full')).toContain('--quick / --full');
    expect(usageError('all', '--quick', '--standard', '--full')).toContain('--quick / --standard / --full');
    expect(usageError('demo', '--json', '--jsonl')).toContain('--json / --jsonl');
  });

  it('rejects invalid --timeout, --limit and --runs', () => {
    for (const bad of ['abc', '0', '1e999', '', '99999']) {
      expect(usageError('demo', `--timeout=${bad}`)).toContain('--timeout');
    }
    for (const bad of ['abc', '0', '1.5', '-1', '']) {
      expect(usageError('history', `--limit=${bad}`)).toContain('--limit expects a whole number');
    }
    for (const bad of ['0', String(MAX_RUNS + 1), '2.5', 'two', '-1', '']) {
      expect(usageError('demo', `--runs=${bad}`)).toContain(`--runs expects a whole number from 1 to ${MAX_RUNS}`);
    }
  });

  it('rejects flags that do not apply to the command', () => {
    expect(usageError('demo', '--limit', '3')).toContain('only applies to "history"');
    expect(usageError('run', '-t', 'claude', '--clear')).toContain('only applies to "history"');
    expect(usageError('demo', '--include-apis')).toContain('only applies to "all"');
    expect(usageError('run', '-t', 'claude', '--profile', 'flash')).toContain('only applies to "demo"');
    expect(usageError('all', '-m', 'sonnet')).toContain('--model only applies to a single target');
    expect(usageError('all', '-t', 'claude')).toContain('"all" benchmarks every detected CLI');
    expect(usageError('compare', '-t', 'a,b', '-m', 'x')).toContain('target:model');
    expect(usageError('detect', '--card')).toContain('not "detect"');
    expect(usageError('history', '--runs', '2')).toContain('not "history"');
    expect(usageError('run', '-t', 'demo', '--cmd', 'x')).toContain('--cmd only applies to the "cmd" target');
    expect(usageError('demo', '-t', 'claude')).toContain('--target only applies to');
    expect(usageError('-m', 'sonnet')).toContain('add -t <target>');
  });

  it('rejects unknown demo profiles and multi-target run', () => {
    expect(usageError('demo', '--profile', 'nosuch')).toContain('Unknown demo profile "nosuch". Valid profiles:');
    expect(usageError('run', '-t', 'demo:nosuch')).toContain('Unknown demo profile "nosuch"');
    expect(usageError('run', '-t', 'demo', '-m', 'nosuch')).toContain('Unknown demo profile "nosuch"');
    expect(usageError('compare', '-t', 'demo:flash,demo:nope')).toContain('Unknown demo profile "nope"');
    expect(usageError('run', '-t', 'claude,codex')).toContain('compare -t a,b');
  });
});
