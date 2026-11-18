import { limitResponseBody } from '../adapters/utils/response-limit.js';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HARNESS_CATALOG,
  PROVIDER_CATALOG,
  type HarnessEntry,
  type ProviderEntry,
  providerApiKey,
} from '../adapters/catalog.js';
import { DEMO_PROFILE_NAMES } from '../adapters/providers/demo.js';
import { ollamaBaseUrl } from '../adapters/providers/ollama.js';
import type { AuthState, TargetInfo } from '../types.js';
import { executableNames, IS_WINDOWS, killTree, spawnTarget } from './platform.js';

export const MISE_WHICH_TIMEOUT_MS = 2000;
export const VERSION_PROBE_TIMEOUT_MS = 2000;
export const CAPABILITY_PROBE_TIMEOUT_MS = 3000;
export const AUTH_PROBE_TIMEOUT_MS = 3000;
const LOCAL_HTTP_TIMEOUT_MS = 450;

export function buildSafeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.MISE_AUTO_INSTALL = 'false';
  env.MISE_NOT_FOUND_AUTO_INSTALL = '0';
  env.NO_COLOR = '1';
  env.CI = '1';
  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}

export interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The process could not be started at all. */
  failed: boolean;
}

const CAPTURE_LIMIT = 256 * 1024;

// Probes run in their own process group, so a Ctrl-C in the terminal does not reach them.
const liveProbes = new Set<number>();
let probeExitHook = false;

function trackProbe(pid: number): void {
  liveProbes.add(pid);
  if (probeExitHook) return;
  probeExitHook = true;
  process.once('exit', () => {
    for (const p of liveProbes) {
      killTree(p, 'SIGKILL');
    }
  });
}

/**
 * Runs a short informational command (`--version`, `--help`, an auth status) and captures its
 * output. Never rejects; stdin is closed so a CLI that reads it cannot hang; on timeout the whole
 * process group is killed.
 */
export function runCapture(
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string }
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null, failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut, failed });
    };

    let child: ReturnType<typeof spawn>;
    try {
      const target = spawnTarget(command, args);
      child = spawn(target.file, target.args, {
        cwd: options.cwd ?? os.tmpdir(),
        env: buildSafeEnv(options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !IS_WINDOWS,
        windowsVerbatimArguments: target.windowsVerbatimArguments,
        windowsHide: true,
      });
    } catch {
      resolve({ stdout, stderr, exitCode: null, timedOut: false, failed: true });
      return;
    }

    const pid = child.pid;
    if (typeof pid === 'number') {
      trackProbe(pid);
      child.once('close', () => liveProbes.delete(pid));
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (typeof child.pid === 'number') {
        killTree(child.pid, 'SIGKILL');
      }
      // A grandchild that left the group can keep the pipes open; do not wait for 'close'.
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, false);
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < CAPTURE_LIMIT) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < CAPTURE_LIMIT) stderr += chunk.toString('utf8');
    });
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.once('error', () => finish(null, true));
    child.once('close', (code) => finish(code, false));
  });
}

export type BinaryStatus =
  /** A real executable was found. */
  | 'found'
  /** Nothing with that name on PATH. */
  | 'missing'
  /** Only mise shims exist and mise says the tool is not installed / not active. */
  | 'shim_inactive'
  /** Only mise shims exist and mise could not be asked (missing, timed out, odd answer). */
  | 'shim_unresolved';

export interface BinaryResolution {
  status: BinaryStatus;
  /** Set only for 'found'; never a mise shim or command wrapper. */
  path: string | null;
  /** The first shim seen on PATH, when there was one. */
  shimPath?: string;
  detail?: string;
}

export interface ResolveBinaryOptions {
  pathEnv?: string;
  miseTimeoutMs?: number;
}

function inMiseShimDir(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/mise/shims/') || normalized.includes('/mise/command-wrappers/');
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

interface ShimCheck {
  shim: boolean;
  /** The mise binary the shim points at, when it is a symlink to it. */
  misePath?: string;
}

async function checkShim(candidate: string): Promise<ShimCheck> {
  let real = candidate;
  try {
    real = await fs.realpath(candidate);
  } catch {
    // Keep the candidate path; the directory test below still applies.
  }
  const isMiseBinary = /^mise(\.exe)?$/i.test(path.basename(real));
  if (isMiseBinary) return { shim: true, misePath: real };
  return { shim: inMiseShimDir(candidate) || inMiseShimDir(real) };
}

async function findMiseBinary(dirs: string[]): Promise<string | undefined> {
  for (const dir of dirs) {
    const candidate = path.join(dir, 'mise');
    if ((await isExecutableFile(candidate)) && !inMiseShimDir(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Finds the real executable for `cmd` without ever running a mise shim.
 *
 * PATH is scanned in order; a candidate that is a mise shim or command wrapper (it lives under
 * `mise/shims/` or `mise/command-wrappers/`, or resolves to the mise binary) is skipped and the
 * scan continues, because the real install directory is often further down PATH. Only when the
 * scan found nothing but shims is `mise which` consulted, with auto-install disabled: it prints
 * the install path for an installed tool and fails for a lazy tool that was never installed.
 */
export async function resolveBinary(cmd: string, options: ResolveBinaryOptions = {}): Promise<BinaryResolution> {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  let shimPath: string | undefined;
  let misePath: string | undefined;

  for (const dir of dirs) {
    for (const name of executableNames(cmd)) {
      const candidate = path.join(dir, name);
      if (!(await isExecutableFile(candidate))) continue;
      const check = await checkShim(candidate);
      if (!check.shim) return { status: 'found', path: candidate };
      shimPath ??= candidate;
      misePath ??= check.misePath;
    }
  }

  if (!shimPath) return { status: 'missing', path: null };

  misePath ??= await findMiseBinary(dirs);
  if (!misePath) {
    return { status: 'shim_unresolved', path: null, shimPath, detail: 'mise itself was not found' };
  }

  const result = await runCapture(misePath, ['which', cmd], {
    timeoutMs: options.miseTimeoutMs ?? MISE_WHICH_TIMEOUT_MS,
    env: { PATH: pathEnv },
    cwd: process.cwd(),
  });
  if (result.timedOut) {
    return { status: 'shim_unresolved', path: null, shimPath, detail: 'mise which timed out' };
  }
  if (result.failed) {
    return { status: 'shim_unresolved', path: null, shimPath, detail: 'mise could not be started' };
  }

  const resolved = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (result.exitCode === 0 && path.isAbsolute(resolved)) {
    if ((await isExecutableFile(resolved)) && !(await checkShim(resolved)).shim) {
      return { status: 'found', path: resolved, shimPath };
    }
    return { status: 'shim_inactive', path: null, shimPath, detail: 'mise points at a missing binary' };
  }
  const message = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode !== 0 && /not currently active|is not a mise bin|not installed|no such/i.test(message)) {
    return { status: 'shim_inactive', path: null, shimPath };
  }
  const firstLine = message.trim().split(/\r?\n/)[0]?.trim().slice(0, 120);
  return {
    status: 'shim_unresolved',
    path: null,
    shimPath,
    detail: firstLine || `mise which exited with ${result.exitCode ?? 'no code'}`,
  };
}

/** The path of the real executable for `cmd`, or null. Never returns a mise shim. */
export async function resolveRealBinary(
  cmd: string,
  pathEnv = process.env.PATH ?? ''
): Promise<string | null> {
  return (await resolveBinary(cmd, { pathEnv })).path;
}

export function describeMissingBinary(resolution: BinaryResolution): string {
  switch (resolution.status) {
    case 'shim_inactive':
      return 'not installed (mise shim present, tool not installed)';
    case 'shim_unresolved':
      return `mise shim found but the real binary could not be located (${resolution.detail ?? 'unknown reason'})`;
    default:
      return 'not installed';
  }
}

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

async function probeVersion(binaryPath: string, timeoutMs = VERSION_PROBE_TIMEOUT_MS): Promise<string | undefined> {
  const result = await runCapture(binaryPath, ['--version'], { timeoutMs });
  if (result.failed || result.timedOut) return undefined;
  const line = (result.stdout || result.stderr)
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

export interface CapabilityResult {
  ok: boolean;
  /** Required strings that the help text does not contain. */
  missing: string[];
  helpText: string;
  timedOut: boolean;
}

const capabilityCache = new Map<string, Promise<CapabilityResult>>();

/**
 * Checks that the flags an experimental adapter depends on appear in the CLI's own help text.
 * Entries without a probe (the verified CLIs) always pass. Results are cached per binary.
 */
export function probeCapability(
  entry: HarnessEntry,
  binaryPath: string,
  timeoutMs = CAPABILITY_PROBE_TIMEOUT_MS
): Promise<CapabilityResult> {
  const probe = entry.capability;
  if (!probe) return Promise.resolve({ ok: true, missing: [], helpText: '', timedOut: false });
  const key = `${entry.id}\u0000${binaryPath}`;
  let pending = capabilityCache.get(key);
  if (!pending) {
    pending = runCapture(binaryPath, probe.args, { timeoutMs }).then((result) => {
      const helpText = `${result.stdout}\n${result.stderr}`.replace(ANSI_RE, '');
      const missing = probe.requires.filter((needle) => !helpText.includes(needle));
      return {
        ok: !result.failed && !result.timedOut && missing.length === 0,
        missing,
        helpText,
        timedOut: result.timedOut,
      };
    });
    capabilityCache.set(key, pending);
  }
  return pending;
}

export function describeUnsupported(entry: HarnessEntry, capability?: CapabilityResult): string {
  if (!entry.create) return `installed, not supported yet (${entry.unsupportedReason ?? 'no adapter'})`;
  if (capability?.timedOut) return 'installed, not supported yet (its help did not answer in time)';
  if (capability && capability.missing.length > 0) {
    return `installed, not supported yet (its help does not list ${capability.missing.join(', ')})`;
  }
  return 'installed, not supported yet';
}

async function probeAuth(
  entry: HarnessEntry,
  binaryPath: string,
  timeoutMs = AUTH_PROBE_TIMEOUT_MS
): Promise<AuthState> {
  if (!entry.auth) return 'unknown';
  const result = await runCapture(binaryPath, entry.auth.args, { timeoutMs });
  if (result.failed || result.timedOut) return 'unknown';
  try {
    return entry.auth.interpret({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
  } catch {
    return 'unknown';
  }
}

export type TargetState = 'ready' | 'logged_out' | 'unsupported' | 'not_installed';

/** TargetInfo plus what discovery learned about the target. */
export interface DetectedTarget extends TargetInfo {
  /** One word for display: runnable, needs a login, installed without an adapter, or absent. */
  state: TargetState;
  /** The command to run to log in, when `authState` is 'logged_out'. */
  loginHint?: string;
  /** A mise shim exists for the command, whether or not the tool is installed. */
  shimPath?: string;
}

export interface DetectOptions {
  pathEnv?: string;
  /** Source of API keys and local endpoints. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Set false to skip the localhost probes for Ollama and LM Studio. */
  probeLocal?: boolean;
  /** Overrides every per-command probe timeout (version, help, auth, mise which). */
  probeTimeoutMs?: number;
}

/** Resolves and probes one catalog CLI. Runs only `--version`, help and auth-status commands. */
export async function inspectHarness(entry: HarnessEntry, options: DetectOptions = {}): Promise<DetectedTarget> {
  const base = {
    id: entry.id,
    name: entry.name,
    category: 'harness' as const,
    tier: entry.tier,
    supportsToolLoop: entry.supportsToolLoop,
  };

  let found: BinaryResolution | undefined;
  let firstMiss: BinaryResolution | undefined;
  for (const command of entry.commands) {
    const resolution = await resolveBinary(command, {
      pathEnv: options.pathEnv,
      miseTimeoutMs: options.probeTimeoutMs,
    });
    if (resolution.status === 'found') {
      found = resolution;
      break;
    }
    if (!firstMiss || (firstMiss.status === 'missing' && resolution.status !== 'missing')) {
      firstMiss = resolution;
    }
  }

  if (!found?.path) {
    const miss = firstMiss ?? { status: 'missing' as const, path: null };
    return {
      ...base,
      available: false,
      runnable: false,
      authState: 'unknown',
      state: 'not_installed',
      shimPath: miss.shimPath,
      reason: describeMissingBinary(miss),
    };
  }

  const binaryPath = found.path;
  const [version, capability, authState] = await Promise.all([
    probeVersion(binaryPath, options.probeTimeoutMs),
    probeCapability(entry, binaryPath, options.probeTimeoutMs),
    probeAuth(entry, binaryPath, options.probeTimeoutMs),
  ]);
  const installed = { ...base, available: true, version, binaryPath, shimPath: found.shimPath };

  if (!entry.create || !capability.ok) {
    return {
      ...installed,
      runnable: false,
      authState: 'unknown',
      state: 'unsupported',
      reason: describeUnsupported(entry, capability),
    };
  }
  if (authState === 'logged_out') {
    const loginHint = entry.auth?.loginHint;
    return {
      ...installed,
      runnable: true,
      authState,
      state: 'logged_out',
      loginHint,
      reason: loginHint ? `not logged in (run: ${loginHint})` : 'not logged in',
    };
  }
  const label = version ?? binaryPath;
  return {
    ...installed,
    runnable: true,
    authState,
    state: 'ready',
    reason: entry.tier === 'experimental' ? `${label} (experimental adapter)` : label,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(LOCAL_HTTP_TIMEOUT_MS), redirect: 'error' });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  return new Response(limitResponseBody(res.body, 4 * 1024 * 1024)).json();
}

function names(list: unknown, key: string): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

async function probeOllama(entry: ProviderEntry, env: NodeJS.ProcessEnv): Promise<DetectedTarget> {
  const baseUrl = ollamaBaseUrl(env);
  const base = {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    tier: 'verified' as const,
    supportsToolLoop: false,
  };
  try {
    const [tags, running] = await Promise.all([
      fetchJson(`${baseUrl}/api/tags`),
      fetchJson(`${baseUrl}/api/ps`).catch(() => undefined),
    ]);
    const models = names((tags as { models?: unknown }).models, 'name');
    const loaded = names((running as { models?: unknown } | undefined)?.models, 'name');
    // A model that is already in memory avoids timing a cold load.
    const defaultModel = loaded.find((name) => models.includes(name)) ?? models[0];
    const ready = models.length > 0;
    return {
      ...base,
      available: ready,
      runnable: ready,
      authState: 'ready',
      state: ready ? 'ready' : 'not_installed',
      defaultModel,
      models,
      reason: ready ? `${models.length} local model(s), using ${defaultModel}` : 'running, but no model is pulled',
    };
  } catch {
    return {
      ...base,
      available: false,
      runnable: false,
      authState: 'unknown',
      state: 'not_installed',
      reason: `not listening on ${baseUrl}`,
    };
  }
}

async function probeLmStudio(entry: ProviderEntry): Promise<DetectedTarget> {
  const baseUrl = entry.defaultBaseUrl ?? 'http://127.0.0.1:1234/v1';
  const base = {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    tier: 'verified' as const,
    supportsToolLoop: false,
  };
  try {
    const data = await fetchJson(`${baseUrl}/models`);
    const models = names((data as { data?: unknown }).data, 'id');
    const ready = models.length > 0;
    return {
      ...base,
      available: ready,
      runnable: ready,
      authState: 'ready',
      state: ready ? 'ready' : 'not_installed',
      defaultModel: models[0],
      models,
      reason: ready ? `${models.length} model(s), using ${models[0]}` : 'listening, but no model is loaded',
    };
  } catch {
    return {
      ...base,
      available: false,
      runnable: false,
      authState: 'unknown',
      state: 'not_installed',
      reason: `not listening on ${baseUrl.replace(/^https?:\/\//, '').replace(/\/v1$/, '')}`,
    };
  }
}

function offlineLocal(entry: ProviderEntry): DetectedTarget {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    tier: 'verified',
    supportsToolLoop: false,
    available: false,
    runnable: false,
    authState: 'unknown',
    state: 'not_installed',
    reason: 'not probed',
  };
}

function detectCloudProvider(entry: ProviderEntry, env: NodeJS.ProcessEnv): DetectedTarget {
  const keyName = entry.envKeys.find((key) => Boolean(env[key]));
  const hasKey = Boolean(providerApiKey(entry, env));
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    tier: 'verified',
    supportsToolLoop: false,
    available: hasKey,
    runnable: hasKey,
    // The key is present but not validated; a bad key shows up as an auth failure in the run.
    authState: 'unknown',
    state: hasKey ? 'ready' : 'not_installed',
    defaultModel: entry.defaultModel,
    reason: hasKey ? `${keyName} set` : `missing ${entry.envKeys.join(' / ')}`,
  };
}

/**
 * Finds every catalog target on this machine. Returns one entry per catalog row (installed or not),
 * in catalog order: agent CLIs, local runtimes, cloud API providers, then the demo simulator.
 * Nothing here spends model tokens, runs a mise shim or triggers an install.
 */
export async function detectTargets(options: DetectOptions = {}): Promise<DetectedTarget[]> {
  const env = options.env ?? process.env;
  const probeLocal = options.probeLocal !== false;

  const harnesses = Promise.all(HARNESS_CATALOG.map((entry) => inspectHarness(entry, options)));
  const providers = Promise.all(
    PROVIDER_CATALOG.map((entry): Promise<DetectedTarget> | DetectedTarget => {
      if (entry.category === 'provider') return detectCloudProvider(entry, env);
      if (!probeLocal) return offlineLocal(entry);
      return entry.id === 'ollama' ? probeOllama(entry, env) : probeLmStudio(entry);
    })
  );

  const demo: DetectedTarget = {
    id: 'demo',
    name: 'Demo Simulator',
    category: 'demo',
    tier: 'verified',
    available: true,
    runnable: true,
    authState: 'ready',
    state: 'ready',
    defaultModel: 'frontier',
    models: [...DEMO_PROFILE_NAMES],
    supportsToolLoop: true,
    reason: 'simulated data, no model is called',
  };

  return [...(await harnesses), ...(await providers), demo];
}
