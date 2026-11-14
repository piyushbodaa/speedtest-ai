import type { AuthState, SpeedtestAdapter, SupportTier, TargetCategory, TargetInfo } from '../types.js';
import { createAgyAdapter } from './harnesses/agy.js';
import { createClaudeAdapter } from './harnesses/claude.js';
import { createCodexAdapter } from './harnesses/codex.js';
import { createGrokAdapter } from './harnesses/grok.js';
import { createMuseAdapter } from './harnesses/muse.js';
import { createTextStreamAdapter, type TextStreamArgContext } from './harnesses/text-stream.js';
import { DEMO_PROFILE_NAMES } from './providers/demo.js';

/**
 * The single table behind detection, the adapter registry, the help text and the target list of
 * `all`. Adding a CLI means adding one entry here.
 */

export type ParserKind =
  | 'claude-stream-json'
  | 'codex-app-server'
  | 'agy-stream-json'
  | 'grok-streaming-json'
  | 'muse-jsonl'
  | 'plain-text'
  | 'none';

/** `<bin> ...args` is run on the real binary; the CLI is runnable only if every string appears. */
export interface CapabilityProbe {
  args: string[];
  requires: string[];
}

export interface AuthProbeOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** A free, token-less login check. Must return 'unknown' unless the output is unambiguous. */
export interface AuthProbe {
  args: string[];
  interpret: (out: AuthProbeOutput) => AuthState;
  loginHint: string;
}

export interface HarnessCreateContext {
  /** Help text captured by the capability probe, when there was one. */
  helpText?: string;
}

export interface HarnessEntry {
  id: string;
  name: string;
  /** Command names searched on PATH, in order. */
  commands: string[];
  tier: SupportTier;
  parser: ParserKind;
  /** What counts as a finished run. */
  terminal: string;
  /** The headless invocation the adapter uses, for the docs and `detect --json`. */
  invocation: string;
  /** What the lean default strips from the user's setup. */
  isolation: string;
  supportsToolLoop: boolean;
  capability?: CapabilityProbe;
  auth?: AuthProbe;
  /** Absent for detect-only entries. */
  create?: (binaryPath: string, ctx: HarnessCreateContext) => SpeedtestAdapter;
  /** Why a detect-only entry has no adapter. */
  unsupportedReason?: string;
}

export interface ProviderEntry {
  id: string;
  name: string;
  category: Extract<TargetCategory, 'provider' | 'local'>;
  /** Environment variables that hold the API key, first match wins. Empty for local runtimes. */
  envKeys: string[];
  defaultModel?: string;
  defaultBaseUrl?: string;
}

function parseClaudeAuth(out: AuthProbeOutput): AuthState {
  try {
    const data = JSON.parse(out.stdout) as { loggedIn?: unknown };
    if (data.loggedIn === true) return 'ready';
    if (data.loggedIn === false) return 'logged_out';
  } catch {
    // Not JSON: an older or newer CLI. Say nothing rather than guess.
  }
  return 'unknown';
}

function parseCodexAuth(out: AuthProbeOutput): AuthState {
  const text = `${out.stdout}\n${out.stderr}`;
  if (/not logged in/i.test(text)) return 'logged_out';
  if (out.exitCode === 0 && /logged in/i.test(text)) return 'ready';
  return 'unknown';
}

interface TextCliSpec {
  id: string;
  name: string;
  commands: string[];
  probe: CapabilityProbe;
  invocation: string;
  argv: (ctx: TextStreamArgContext) => string[];
  modelFlag?: string;
  stripAnsi?: boolean;
}

const TEXT_ISOLATION = 'empty temp cwd; no tool-approval flags are passed';

function textCli(spec: TextCliSpec): HarnessEntry {
  return {
    id: spec.id,
    name: spec.name,
    commands: spec.commands,
    tier: 'experimental',
    parser: 'plain-text',
    terminal: 'exit code 0',
    invocation: spec.invocation,
    isolation: TEXT_ISOLATION,
    supportsToolLoop: false,
    capability: spec.probe,
    create: (binaryPath, ctx) =>
      createTextStreamAdapter({
        id: spec.id,
        name: spec.name,
        binaryPath,
        buildArgs: spec.argv,
        helpText: ctx.helpText,
        modelFlag: spec.modelFlag,
        stripAnsi: spec.stripAnsi,
      }),
  };
}

function detectOnly(id: string, name: string, commands: string[], unsupportedReason: string): HarnessEntry {
  return {
    id,
    name,
    commands,
    tier: 'experimental',
    parser: 'none',
    terminal: 'n/a',
    invocation: 'n/a',
    isolation: 'n/a',
    supportsToolLoop: false,
    unsupportedReason,
  };
}

const model = (ctx: TextStreamArgContext, flag: string): string[] => (ctx.model ? [flag, ctx.model] : []);
const NO_HEADLESS_MODE = 'no confirmed headless invocation yet';

export const HARNESS_CATALOG: readonly HarnessEntry[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    commands: ['claude'],
    tier: 'verified',
    parser: 'claude-stream-json',
    terminal: 'non-error `result` event',
    invocation: 'claude -p <prompt> --output-format stream-json --verbose --include-partial-messages',
    isolation: '--safe-mode: keeps login and model, drops MCP servers, hooks and plugins',
    supportsToolLoop: true,
    auth: { args: ['auth', 'status'], interpret: parseClaudeAuth, loginHint: 'claude auth login' },
    create: (binaryPath) => createClaudeAdapter(binaryPath),
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    commands: ['codex'],
    tier: 'verified',
    parser: 'codex-app-server',
    terminal: '`turn/completed` notification (fallback `codex exec --json`: `turn.completed`)',
    invocation: 'codex app-server (JSON-RPC over stdio); falls back to codex exec --json, which is buffered',
    isolation: 'plugins, apps, hooks, memories and the user MCP servers are disabled',
    supportsToolLoop: true,
    auth: { args: ['login', 'status'], interpret: parseCodexAuth, loginHint: 'codex login' },
    create: (binaryPath) => createCodexAdapter(binaryPath),
  },
  {
    id: 'agy',
    name: 'Antigravity CLI',
    commands: ['agy'],
    tier: 'verified',
    parser: 'agy-stream-json',
    terminal: 'successful `result` event',
    invocation: 'agy -p <prompt> --output-format stream-json',
    isolation: 'empty temp cwd; the tool-loop phase needs --allow-permission-bypass and is skipped without it',
    supportsToolLoop: true,
    create: (binaryPath) => createAgyAdapter(binaryPath),
  },
  {
    id: 'grok',
    name: 'Grok CLI',
    commands: ['grok'],
    tier: 'verified',
    parser: 'grok-streaming-json',
    terminal: 'non-error `result` event',
    invocation: 'grok -p <prompt> --output-format streaming-messages-json --include-partial-messages',
    isolation: 'tool allow-list reduced to read_file; the tool-loop phase needs --allow-permission-bypass',
    supportsToolLoop: true,
    create: (binaryPath) => createGrokAdapter(binaryPath),
  },
  {
    id: 'muse',
    name: 'Muse Code CLI',
    commands: ['muse'],
    tier: 'verified',
    parser: 'muse-jsonl',
    terminal: '`run.terminal.completed` event',
    invocation: 'muse exec --json -- <prompt>',
    isolation: 'empty preset, reminders disabled',
    supportsToolLoop: true,
    create: (binaryPath) => createMuseAdapter(binaryPath),
  },

  textCli({
    id: 'gemini',
    name: 'Gemini CLI',
    commands: ['gemini'],
    probe: { args: ['--help'], requires: ['--prompt', '--model'] },
    invocation: 'gemini [--model <m>] --prompt <prompt>',
    argv: (ctx) => [...model(ctx, '--model'), '--prompt', ctx.prompt],
    modelFlag: '--model',
  }),
  textCli({
    id: 'qwen',
    name: 'Qwen Code',
    commands: ['qwen'],
    probe: { args: ['--help'], requires: ['--prompt', '--model'] },
    invocation: 'qwen [--model <m>] --prompt <prompt>',
    argv: (ctx) => [...model(ctx, '--model'), '--prompt', ctx.prompt],
    modelFlag: '--model',
  }),
  textCli({
    id: 'opencode',
    name: 'OpenCode',
    commands: ['opencode'],
    probe: { args: ['run', '--help'], requires: ['message', '--model'] },
    invocation: 'opencode run [--model <provider/model>] <prompt>',
    argv: (ctx) => ['run', ...model(ctx, '--model'), ctx.prompt],
    modelFlag: '--model',
  }),
  textCli({
    id: 'kilo',
    name: 'Kilo Code CLI',
    commands: ['kilo'],
    probe: { args: ['run', '--help'], requires: ['message', '--model'] },
    invocation: 'kilo run [--model <provider/model>] <prompt>',
    argv: (ctx) => ['run', ...model(ctx, '--model'), ctx.prompt],
    modelFlag: '--model',
  }),
  textCli({
    id: 'cursor-agent',
    name: 'Cursor Agent CLI',
    commands: ['cursor-agent'],
    probe: { args: ['--help'], requires: ['--print', '--output-format'] },
    invocation: 'cursor-agent --print --output-format text [--model <m>] <prompt>',
    argv: (ctx) => ['--print', '--output-format', 'text', ...model(ctx, '--model'), ctx.prompt],
    modelFlag: '--model',
  }),
  textCli({
    id: 'amp',
    name: 'Amp',
    commands: ['amp'],
    probe: { args: ['--help'], requires: ['--execute'] },
    invocation: 'amp --execute <prompt>',
    argv: (ctx) => ['--execute', ctx.prompt],
  }),
  textCli({
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    commands: ['copilot'],
    probe: { args: ['--help'], requires: ['--prompt'] },
    invocation: 'copilot [--silent] [--model <m>] --prompt <prompt>',
    argv: (ctx) => [
      ...(ctx.has('--silent') ? ['--silent'] : []),
      ...model(ctx, '--model'),
      '--prompt',
      ctx.prompt,
    ],
    modelFlag: '--model',
  }),
  textCli({
    id: 'crush',
    name: 'Crush',
    commands: ['crush'],
    probe: { args: ['run', '--help'], requires: ['--quiet'] },
    invocation: 'crush run --quiet [--model <m>] <prompt>',
    argv: (ctx) => ['run', '--quiet', ...model(ctx, '--model'), ctx.prompt],
    modelFlag: '--model',
  }),
  textCli({
    id: 'pi',
    name: 'Pi Coding Agent',
    commands: ['pi'],
    probe: { args: ['--help'], requires: ['--print'] },
    invocation: 'pi --print [--no-session] [--model <m>] <prompt>',
    argv: (ctx) => [
      '--print',
      ...(ctx.has('--no-session') ? ['--no-session'] : []),
      ...model(ctx, '--model'),
      ctx.prompt,
    ],
    modelFlag: '--model',
  }),
  textCli({
    id: 'omp',
    name: 'Oh My Pi',
    commands: ['omp'],
    probe: { args: ['--help'], requires: ['--print'] },
    invocation: 'omp --print [--no-session] [--model <m>] <prompt>',
    argv: (ctx) => [
      '--print',
      ...(ctx.has('--no-session') ? ['--no-session'] : []),
      ...model(ctx, '--model'),
      ctx.prompt,
    ],
    modelFlag: '--model',
  }),
  textCli({
    id: 'kiro-cli',
    name: 'Kiro CLI',
    commands: ['kiro-cli'],
    probe: { args: ['chat', '--help'], requires: ['--no-interactive'] },
    invocation: 'kiro-cli chat --no-interactive [--model <m>] <prompt>',
    argv: (ctx) => ['chat', '--no-interactive', ...model(ctx, '--model'), ctx.prompt],
    modelFlag: '--model',
    stripAnsi: true,
  }),
  textCli({
    id: 'goose',
    name: 'Goose',
    commands: ['goose'],
    probe: { args: ['run', '--help'], requires: ['--text', '--no-session'] },
    invocation: 'goose run --no-session [--quiet] [--model <m>] --text <prompt>',
    argv: (ctx) => [
      'run',
      '--no-session',
      ...(ctx.has('--quiet') ? ['--quiet'] : []),
      ...model(ctx, '--model'),
      '--text',
      ctx.prompt,
    ],
    modelFlag: '--model',
    stripAnsi: true,
  }),
  textCli({
    id: 'droid',
    name: 'Factory Droid',
    commands: ['droid'],
    probe: { args: ['exec', '--help'], requires: ['--output-format'] },
    invocation: 'droid exec --output-format text [--model <m>] <prompt>',
    argv: (ctx) => ['exec', '--output-format', 'text', ...model(ctx, '--model'), ctx.prompt],
    modelFlag: '--model',
  }),

  detectOnly(
    'aider',
    'Aider',
    ['aider'],
    'prints a banner and cost lines on stdout, so first-token timing cannot be measured from plain text'
  ),
  detectOnly('kimi', 'Kimi Code', ['kimi'], NO_HEADLESS_MODE),
  detectOnly('devin', 'Devin CLI', ['devin'], NO_HEADLESS_MODE),
  detectOnly('commandcode', 'Command Code', ['commandcode'], NO_HEADLESS_MODE),
  detectOnly('freebuff', 'Freebuff', ['freebuff'], NO_HEADLESS_MODE),
  detectOnly('mcode', 'MiniMax Code', ['mcode'], NO_HEADLESS_MODE),
  detectOnly('dsh', 'DeepSeek CLI', ['dsh'], NO_HEADLESS_MODE),
  detectOnly('auggie', 'Augment CLI', ['auggie'], NO_HEADLESS_MODE),
  detectOnly('cline', 'Cline CLI', ['cline'], NO_HEADLESS_MODE),
];

export const PROVIDER_CATALOG: readonly ProviderEntry[] = [
  { id: 'ollama', name: 'Ollama (Local)', category: 'local', envKeys: [], defaultBaseUrl: 'http://127.0.0.1:11434' },
  {
    id: 'lmstudio',
    name: 'LM Studio (Local)',
    category: 'local',
    envKeys: [],
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    category: 'provider',
    envKeys: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-4.1-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'anthropic',
    name: 'Anthropic API',
    category: 'provider',
    envKeys: ['ANTHROPIC_API_KEY'],
    defaultModel: 'claude-sonnet-5-5',
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'gemini-api',
    name: 'Google Gemini API',
    category: 'provider',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    defaultModel: 'gemini-2.5-flash',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter API',
    category: 'provider',
    envKeys: ['OPENROUTER_API_KEY'],
    defaultModel: 'openai/gpt-4.1-mini',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
];

/** Target ids that are not table rows: the simulator and the user-supplied shell command. */
export const SPECIAL_TARGET_IDS = ['demo', 'cmd'] as const;

export function findHarnessEntry(id: string): HarnessEntry | undefined {
  return HARNESS_CATALOG.find((entry) => entry.id === id);
}

export function findProviderEntry(id: string): ProviderEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.id === id);
}

/** Every id `-t` accepts (an unknown id is still accepted together with --base-url). */
export function knownTargetIds(): string[] {
  return [
    ...HARNESS_CATALOG.map((entry) => entry.id),
    ...PROVIDER_CATALOG.map((entry) => entry.id),
    ...SPECIAL_TARGET_IDS,
  ];
}

export function providerApiKey(entry: ProviderEntry, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of entry.envKeys) {
    const value = env[key];
    if (value) return value;
  }
  return undefined;
}

export interface SelectAllOptions {
  /** Also benchmark cloud API-key providers (they bill per token). Default false. */
  includeApis?: boolean;
}

function allExclusionReason(target: TargetInfo, options: SelectAllOptions): string | undefined {
  if (target.category === 'demo' || target.category === 'custom') return 'not a real target';
  if (!target.available) return target.reason ?? 'not installed';
  if (!target.runnable) return target.reason ?? 'installed, not supported yet';
  if (target.authState === 'logged_out') return target.reason ?? 'not logged in';
  if (target.category === 'provider' && !options.includeApis) {
    return 'cloud API targets are only benchmarked with --include-apis';
  }
  return undefined;
}

/**
 * The targets `all` benchmarks: every runnable agent CLI that is not known to be logged out, plus
 * running local runtimes, plus cloud API providers only with `includeApis`. Never the demo.
 */
export function selectAllTargets<T extends TargetInfo>(detected: readonly T[], options: SelectAllOptions = {}): T[] {
  return detected.filter((target) => allExclusionReason(target, options) === undefined);
}

export interface SkippedTarget {
  id: string;
  name: string;
  reason: string;
}

/** Targets that exist on this machine but that `all` leaves out, with the reason to show. */
export function explainAllSkips(
  detected: readonly TargetInfo[],
  options: SelectAllOptions = {}
): SkippedTarget[] {
  const skipped: SkippedTarget[] = [];
  for (const target of detected) {
    if (!target.available || target.category === 'demo' || target.category === 'custom') continue;
    const reason = allExclusionReason(target, options);
    if (reason) skipped.push({ id: target.id, name: target.name, reason });
  }
  return skipped;
}

function wrapList(label: string, ids: string[], width: number): string[] {
  const indent = ' '.repeat(label.length);
  const lines: string[] = [];
  let line = label;
  ids.forEach((id, index) => {
    const piece = index < ids.length - 1 ? `${id},` : id;
    const atLineStart = line.length === label.length;
    if (!atLineStart && line.length + 1 + piece.length > width) {
      lines.push(line);
      line = indent + piece;
    } else {
      line += atLineStart ? piece : ` ${piece}`;
    }
  });
  lines.push(line);
  return lines;
}

/** The TARGETS block of the help text, wrapped to `width` columns. */
export function targetsHelpLines(width = 80): string[] {
  const verified = HARNESS_CATALOG.filter((entry) => entry.tier === 'verified').map((entry) => entry.id);
  const experimental = HARNESS_CATALOG.filter((entry) => entry.tier === 'experimental' && entry.create).map(
    (entry) => entry.id
  );
  const detectOnlyIds = HARNESS_CATALOG.filter((entry) => !entry.create).map((entry) => entry.id);
  const local = PROVIDER_CATALOG.filter((entry) => entry.category === 'local').map((entry) => `${entry.id}:<model>`);
  const cloud = PROVIDER_CATALOG.filter((entry) => entry.category === 'provider').map(
    (entry) => `${entry.id}:<model>`
  );
  return [
    ...wrapList('  Agent CLIs:    ', verified, width),
    ...wrapList('  Experimental:  ', experimental, width),
    ...wrapList('  Detect only:   ', detectOnlyIds, width),
    ...wrapList('  Custom:        ', ['cmd (with --cmd "<command>")'], width),
    ...wrapList('  Local:         ', local, width),
    ...wrapList('  Cloud APIs:    ', cloud, width),
    ...wrapList(
      '  Simulated:     ',
      DEMO_PROFILE_NAMES.map((name) => `demo:${name}`),
      width
    ),
  ];
}
