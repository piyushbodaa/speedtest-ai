import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TargetInfo } from '../types.js';

const execFileAsync = promisify(execFile);

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

function isShimPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/mise/shims/') || normalized.includes('/.mise/shims/');
}

export async function resolveRealBinary(
  cmd: string,
  pathEnv = process.env.PATH ?? ''
): Promise<string | null> {
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  let shimCandidate: string | null = null;

  for (const dir of dirs) {
    const candidate = path.join(dir, cmd);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      const st = await fs.stat(candidate);
      if (!st.isFile()) continue;

      if (!isShimPath(candidate)) {
        return candidate;
      }
      if (!shimCandidate) {
        shimCandidate = candidate;
      }
    } catch {
      // Not present or not executable
    }
  }

  if (shimCandidate) {
    try {
      const { stdout } = await execFileAsync('mise', ['which', cmd], {
        timeout: 1500,
        env: buildSafeEnv(),
      });
      const resolved = stdout.trim();
      if (resolved) {
        return resolved;
      }
    } catch {
      return null;
    }
  }

  return null;
}

async function probeVersion(binaryPath: string, versionArgs = ['--version']): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, versionArgs, {
      timeout: 2000,
      env: buildSafeEnv(),
    });
    const text = (stdout || stderr || '').trim().split(/\r?\n/)[0]?.trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

interface HarnessDef {
  id: string;
  name: string;
  cmd: string;
  defaultModel: string;
}

const HARNESS_DEFS: HarnessDef[] = [
  { id: 'claude', name: 'Claude Code', cmd: 'claude', defaultModel: 'default' },
  { id: 'codex', name: 'OpenAI Codex CLI', cmd: 'codex', defaultModel: 'default' },
  { id: 'agy', name: 'Antigravity CLI', cmd: 'agy', defaultModel: 'gemini-4-carbon-low' },
  { id: 'grok', name: 'Grok CLI', cmd: 'grok', defaultModel: 'default' },
  { id: 'muse', name: 'Muse Code CLI', cmd: 'muse', defaultModel: 'muse-spark-1.3' },
];

async function probeOllama(): Promise<TargetInfo> {
  const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const baseUrl = host.startsWith('http') ? host : `http://${host}`;
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(450),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    return {
      id: 'ollama',
      name: 'Ollama (Local)',
      category: 'local',
      available: models.length > 0,
      defaultModel: models[0],
      models,
      supportsToolLoop: false,
      reason:
        models.length > 0
          ? `${models.length} local model(s) ready (${models[0]})`
          : 'Ollama running but no models pulled',
    };
  } catch {
    return {
      id: 'ollama',
      name: 'Ollama (Local)',
      category: 'local',
      available: false,
      supportsToolLoop: false,
      reason: `Not listening on ${baseUrl}`,
    };
  }
}

async function probeLmStudio(): Promise<TargetInfo> {
  const baseUrl = 'http://127.0.0.1:1234/v1';
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(450),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    return {
      id: 'lmstudio',
      name: 'LM Studio (Local)',
      category: 'local',
      available: models.length > 0,
      defaultModel: models[0],
      models,
      supportsToolLoop: false,
      reason:
        models.length > 0
          ? `${models.length} loaded model(s) (${models[0]})`
          : 'LM Studio listening but no model loaded',
    };
  } catch {
    return {
      id: 'lmstudio',
      name: 'LM Studio (Local)',
      category: 'local',
      available: false,
      supportsToolLoop: false,
      reason: 'Not listening on 127.0.0.1:1234',
    };
  }
}

function detectCloudProviders(): TargetInfo[] {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  return [
    {
      id: 'openai',
      name: 'OpenAI API',
      category: 'provider',
      available: Boolean(openaiKey),
      defaultModel: 'gpt-4.1-mini',
      supportsToolLoop: false,
      reason: openaiKey ? 'OPENAI_API_KEY set' : 'Missing OPENAI_API_KEY',
    },
    {
      id: 'anthropic',
      name: 'Anthropic API',
      category: 'provider',
      available: Boolean(anthropicKey),
      defaultModel: 'claude-sonnet-4-20250514',
      supportsToolLoop: false,
      reason: anthropicKey ? 'ANTHROPIC_API_KEY set' : 'Missing ANTHROPIC_API_KEY',
    },
    {
      id: 'gemini',
      name: 'Google Gemini API',
      category: 'provider',
      available: Boolean(geminiKey),
      defaultModel: 'gemini-2.5-flash',
      supportsToolLoop: false,
      reason: geminiKey ? 'GEMINI_API_KEY set' : 'Missing GEMINI_API_KEY / GOOGLE_API_KEY',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter API',
      category: 'provider',
      available: Boolean(openrouterKey),
      defaultModel: 'openai/gpt-4.1-mini',
      supportsToolLoop: false,
      reason: openrouterKey ? 'OPENROUTER_API_KEY set' : 'Missing OPENROUTER_API_KEY',
    },
  ];
}

export async function detectTargets(): Promise<TargetInfo[]> {
  const harnessPromises = HARNESS_DEFS.map(async (def): Promise<TargetInfo> => {
    const binaryPath = await resolveRealBinary(def.cmd);
    if (!binaryPath) {
      return {
        id: def.id,
        name: def.name,
        category: 'harness',
        available: false,
        defaultModel: def.defaultModel,
        supportsToolLoop: true,
        reason: `Binary '${def.cmd}' not installed`,
      };
    }

    const version = await probeVersion(binaryPath);
    return {
      id: def.id,
      name: def.name,
      category: 'harness',
      available: true,
      version,
      binaryPath,
      defaultModel: def.defaultModel,
      supportsToolLoop: true,
      reason: version ? `Installed (${version})` : `Installed at ${binaryPath}`,
    };
  });

  const [harnesses, ollama, lmstudio] = await Promise.all([
    Promise.all(harnessPromises),
    probeOllama(),
    probeLmStudio(),
  ]);

  const providers = detectCloudProviders();

  const demo: TargetInfo = {
    id: 'demo',
    name: 'Demo Simulator',
    category: 'demo',
    available: true,
    defaultModel: 'frontier',
    models: ['frontier', 'flash', 'reasoning', 'local'],
    supportsToolLoop: true,
    reason: 'Zero-setup simulated speedometer (no API cost)',
  };

  return [...harnesses, ollama, lmstudio, ...providers, demo];
}
