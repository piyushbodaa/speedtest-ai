import { parseArgs } from 'node:util';
import { knownTargetIds } from './adapters/catalog.js';
import { DEMO_PROFILE_NAMES, isDemoProfileName } from './adapters/providers/demo.js';
import { DEFAULT_PHASE_TIMEOUT_MS, MAX_RUNS } from './core/runner.js';
import type { BenchmarkMode } from './types.js';

/** A problem with the command line itself. The CLI prints it and exits with code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type CliOutputMode = 'tui' | 'plain' | 'json' | 'jsonl';

export const DEFAULT_CARD_PATH = 'speedtest-ai-card.svg';
export const DEFAULT_HISTORY_LIMIT = 15;
export const MAX_TIMEOUT_SECONDS = 3600;

export interface RunOptions {
  /** Undefined when no mode flag was given; each command has its own default. */
  mode?: BenchmarkMode;
  timeoutMs: number;
  runs: number;
  asConfigured: boolean;
  allowPermissionBypass: boolean;
  /** Run the targets of `all` / `compare` at the same time. */
  parallel: boolean;
  /** Do not write the shareable result image. */
  noCard: boolean;
  noHistory: boolean;
  output: CliOutputMode;
  cardPath?: string;
  model?: string;
  cmd?: string;
  baseUrl?: string;
  apiKey?: string;
}

export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'update' }
  | { kind: 'share' }
  | { kind: 'menu'; format: 'json' | 'swiftbar' }
  | { kind: 'menubar'; action: 'install' | 'uninstall' }
  | { kind: 'detect'; json: boolean }
  | { kind: 'history'; json: boolean; limit: number; clear: boolean }
  | { kind: 'run'; targetSpec: string; run: RunOptions }
  | { kind: 'compare'; specs: string[]; run: RunOptions }
  | { kind: 'all'; includeApis: boolean; run: RunOptions }
  /** `pick`: the interactive picker on a terminal, the overview otherwise. */
  | { kind: 'default'; run: RunOptions };

const COMMANDS = ['all', 'run', 'demo', 'compare', 'detect', 'history', 'update', 'menu', 'menubar', 'pick', 'share', 'help'] as const;
type CommandName = (typeof COMMANDS)[number];

function looksLikeCardPath(token: string): boolean {
  return /\.svg$/i.test(token) || token.includes('/') || token.includes('\\');
}

/**
 * `--card` takes an optional path. The next token is only taken as that path when it ends in
 * .svg or contains a path separator, so `--card demo` still runs the demo.
 */
export function normalizeOptionalCardFlag(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (arg === '--card') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-') && looksLikeCardPath(next)) {
        out.push(`--card=${next}`);
        i += 1;
      } else {
        out.push(`--card=${DEFAULT_CARD_PATH}`);
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

function parsePositiveNumber(flag: string, raw: string, max: number): number {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${flag} expects a positive number, got "${raw}".`);
  }
  if (value > max) throw new UsageError(`${flag} must be at most ${max}, got "${raw}".`);
  return value;
}

function parseIntegerInRange(flag: string, raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value) || value < min || value > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `a whole number of at least ${min}` : `a whole number from ${min} to ${max}`;
    throw new UsageError(`${flag} expects ${range}, got "${raw}".`);
  }
  return value;
}

function cleanParseError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const needsValue = message.match(/^Option '([^']+)' argument (?:is ambiguous|missing)/);
  if (needsValue) return `${needsValue[1].replace(/ <value>$/, '')} needs a value.`;
  // Node appends advice about "--" that does not apply here.
  return message.split('. To specify')[0].replace(/\.$/, '') + '.';
}

export function parseCliArgs(rawArgv: string[]): ParsedCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: normalizeOptionalCardFlag(rawArgv),
      allowPositionals: true,
      strict: true,
      options: {
        all: { type: 'boolean', short: 'a' },
        target: { type: 'string', short: 't' },
        model: { type: 'string', short: 'm' },
        profile: { type: 'string' },
        quick: { type: 'boolean' },
        standard: { type: 'boolean' },
        full: { type: 'boolean' },
        runs: { type: 'string' },
        'as-configured': { type: 'boolean' },
        'allow-permission-bypass': { type: 'boolean' },
        parallel: { type: 'boolean', short: 'p' },
        'no-card': { type: 'boolean' },
        'include-apis': { type: 'boolean' },
        cmd: { type: 'string' },
        'base-url': { type: 'string' },
        'api-key': { type: 'string' },
        card: { type: 'string' },
        json: { type: 'boolean' },
        jsonl: { type: 'boolean' },
        plain: { type: 'boolean' },
        'no-history': { type: 'boolean' },
        timeout: { type: 'string' },
        limit: { type: 'string' },
        clear: { type: 'boolean' },
        swiftbar: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    throw new UsageError(cleanParseError(err));
  }

  const { values, positionals } = parsed;
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  // `speedtest claude` tests that agent; `speedtest claude codex` compares them. A name is taken
  // as a target only when it is one this build knows, so a typo is still reported as a typo.
  let shortcut = false;
  if (positionals.length > 0 && !(COMMANDS as readonly string[]).includes(positionals[0])) {
    const known = knownTargetIds();
    const isTarget = (word: string) => known.includes(word.split(':')[0].trim().toLowerCase());
    if (!positionals.every(isTarget)) {
      const unknown = positionals.find((word) => !isTarget(word))!;
      throw new UsageError(
        `Unknown command or agent "${unknown}". Commands: ${COMMANDS.filter((n) => n !== 'help').join(', ')}. Agents: see "speedtest detect".`
      );
    }
    if (values.target !== undefined) throw new UsageError('Name the agent once: either "speedtest claude" or "-t claude".');
    (values as { target?: string }).target = positionals.join(',');
    shortcut = true;
    positionals.splice(0, positionals.length, positionals.length > 1 ? 'compare' : 'run');
  }

  const first = positionals[0];
  if (first === 'menubar') {
    const action = positionals[1];
    if (positionals.length !== 2 || (action !== 'install' && action !== 'uninstall')) {
      throw new UsageError('Usage: speedtest menubar install | uninstall');
    }
    return { kind: 'menubar', action };
  }
  if (positionals.length > 1) {
    throw new UsageError(`Unexpected argument "${positionals[1]}" after "${first}".`);
  }
  let command = first as CommandName | undefined;
  if (command === 'help') return { kind: 'help' };
  if (command === 'update') return { kind: 'update' };
  if (command === 'share') return { kind: 'share' };
  if (command === 'menu') return { kind: 'menu', format: values.swiftbar ? 'swiftbar' : 'json' };
  if (values.swiftbar) throw new UsageError('--swiftbar only applies to "menu".');

  const modeFlags = (['quick', 'standard', 'full'] as const).filter((m) => values[m]);
  if (modeFlags.length > 1) {
    throw new UsageError(`Choose one of ${modeFlags.map((m) => `--${m}`).join(' / ')}, not several.`);
  }
  if (values.json && values.jsonl) throw new UsageError('Choose one of --json / --jsonl, not both.');

  const reject = (flag: string, given: unknown, where: string) => {
    if (given !== undefined && given !== false) throw new UsageError(`${flag} only applies to ${where}.`);
  };

  if (command === 'detect') {
    for (const flag of ['target', 'model', 'profile', 'runs', 'cmd', 'base-url', 'api-key', 'card', 'timeout', 'limit'] as const) {
      reject(`--${flag}`, values[flag], 'benchmark commands, not "detect"');
    }
    return { kind: 'detect', json: Boolean(values.json || values.jsonl) };
  }

  if (command === 'history') {
    for (const flag of ['target', 'model', 'profile', 'runs', 'cmd', 'base-url', 'api-key', 'card', 'timeout'] as const) {
      reject(`--${flag}`, values[flag], 'benchmark commands, not "history"');
    }
    return {
      kind: 'history',
      json: Boolean(values.json || values.jsonl),
      limit:
        values.limit === undefined
          ? DEFAULT_HISTORY_LIMIT
          : parseIntegerInRange('--limit', values.limit, 1, Number.MAX_SAFE_INTEGER),
      clear: Boolean(values.clear),
    };
  }

  reject('--limit', values.limit, '"history"');
  reject('--clear', values.clear, '"history"');

  const run: RunOptions = {
    mode: modeFlags[0],
    timeoutMs:
      values.timeout === undefined
        ? DEFAULT_PHASE_TIMEOUT_MS
        : Math.round(parsePositiveNumber('--timeout', values.timeout, MAX_TIMEOUT_SECONDS) * 1000),
    runs: values.runs === undefined ? 1 : parseIntegerInRange('--runs', values.runs, 1, MAX_RUNS),
    asConfigured: Boolean(values['as-configured']),
    allowPermissionBypass: Boolean(values['allow-permission-bypass']),
    parallel: Boolean(values.parallel),
    noCard: Boolean(values['no-card']),
    noHistory: Boolean(values['no-history']),
    output: values.jsonl ? 'jsonl' : values.json ? 'json' : values.plain ? 'plain' : 'tui',
    cardPath: values.card,
    model: values.model,
    cmd: values.cmd,
    baseUrl: values['base-url'],
    apiKey: values['api-key'],
  };
  // Naming an agent is the everyday form, so it runs the everyday (quick) test.
  if (shortcut && run.mode === undefined) run.mode = 'quick';
  if (run.cardPath !== undefined && run.cardPath.trim() === '') {
    throw new UsageError('--card expects a file path.');
  }
  for (const flag of ['target', 'model', 'profile', 'cmd', 'base-url', 'api-key'] as const) {
    if (values[flag] !== undefined && values[flag]!.trim() === '') {
      throw new UsageError(`--${flag} expects a value.`);
    }
  }

  const targetIsAll = values.target !== undefined && values.target.trim().toLowerCase() === 'all';
  if (values.all || targetIsAll) {
    if (command !== undefined && command !== 'all' && command !== 'run') {
      throw new UsageError(`"${command}" cannot be combined with --all.`);
    }
    if (values.target !== undefined && !targetIsAll) {
      throw new UsageError('--all benchmarks every detected CLI; do not combine it with -t.');
    }
    command = 'all';
  }

  if (command === 'all') {
    if (values.target !== undefined && !targetIsAll) {
      throw new UsageError('"all" benchmarks every detected CLI; use "run -t <target>" or "compare -t a,b" to choose.');
    }
    reject('--model', values.model, 'a single target ("all" uses each CLI\'s own configured model)');
    reject('--profile', values.profile, '"demo"');
    reject('--cmd', values.cmd, '"run -t cmd"');
    reject('--base-url', values['base-url'], 'a single target');
    reject('--api-key', values['api-key'], 'a single target');
    return { kind: 'all', includeApis: Boolean(values['include-apis']), run };
  }

  reject('--include-apis', values['include-apis'], '"all"');

  if (command === 'demo') {
    reject('--target', values.target, '"run" / "compare" ("demo" picks its profile with --profile)');
    reject('--cmd', values.cmd, '"run -t cmd"');
    reject('--base-url', values['base-url'], 'API targets');
    reject('--api-key', values['api-key'], 'API targets');
    if (values.profile !== undefined && values.model !== undefined && values.profile !== values.model) {
      throw new UsageError('Give the demo profile once, with --profile.');
    }
    const profile = values.profile ?? values.model ?? 'frontier';
    if (!isDemoProfileName(profile)) {
      throw new UsageError(`Unknown demo profile "${profile}". Valid profiles: ${DEMO_PROFILE_NAMES.join(', ')}.`);
    }
    return { kind: 'run', targetSpec: `demo:${profile}`, run: { ...run, model: undefined } };
  }

  reject('--profile', values.profile, '"demo"');

  if (command === 'compare') {
    if (values.target === undefined) {
      throw new UsageError('compare needs -t <t1,t2,...> (for example: compare -t claude,codex).');
    }
    reject('--model', values.model, 'a single target (write compare targets as target:model)');
    const specs = values.target
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (specs.length === 0) throw new UsageError('compare needs at least one target after -t.');
    for (const spec of specs) validateDemoSpec(spec);
    return { kind: 'compare', specs, run };
  }

  if (command === 'run' || values.target !== undefined || values.cmd !== undefined || values['base-url'] !== undefined) {
    const targetSpec = values.target?.trim() || (values.cmd !== undefined ? 'cmd' : values['base-url'] !== undefined ? 'custom' : '');
    if (!targetSpec) {
      throw new UsageError('run needs a target: -t <target[:model]> (see "speedtest detect").');
    }
    if (targetSpec.includes(',')) {
      throw new UsageError('run takes one target; use "compare -t a,b" for several.');
    }
    const id = targetSpec.split(':')[0].trim().toLowerCase();
    if (values.cmd !== undefined && id !== 'cmd') {
      throw new UsageError('--cmd only applies to the "cmd" target (run -t cmd --cmd "...").');
    }
    if (id === 'cmd' && values.cmd === undefined) {
      throw new UsageError('Target "cmd" needs --cmd "<command template>".');
    }
    validateDemoSpec(values.model !== undefined && id === 'demo' ? `demo:${values.model}` : targetSpec);
    return { kind: 'run', targetSpec, run };
  }

  reject('--model', values.model, 'a target (add -t <target>)');
  reject('--api-key', values['api-key'], 'a target (add -t <target>)');
  if (command === 'pick') return { kind: 'default', run };
  // No command and no agent: test them all.
  return { kind: 'all', includeApis: false, run };
}

function validateDemoSpec(spec: string): void {
  const [id, ...rest] = spec.split(':');
  if (id.trim().toLowerCase() !== 'demo') return;
  const profile = rest.join(':').trim();
  if (profile !== '' && !isDemoProfileName(profile)) {
    throw new UsageError(`Unknown demo profile "${profile}". Valid profiles: ${DEMO_PROFILE_NAMES.join(', ')}.`);
  }
}
