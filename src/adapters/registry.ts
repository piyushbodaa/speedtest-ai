import {
  describeMissingBinary,
  describeUnsupported,
  probeCapability,
  resolveBinary,
  type BinaryResolution,
} from '../core/detect.js';
import { TargetFailedError } from '../core/errors.js';
import type { SpeedtestAdapter, SupportTier, TargetInfo } from '../types.js';
import {
  findHarnessEntry,
  findProviderEntry,
  type HarnessEntry,
  type ProviderEntry,
  providerApiKey,
} from './catalog.js';
import { createCustomCmdAdapter } from './harnesses/custom-cmd.js';
import { createAnthropicAdapter } from './providers/anthropic.js';
import { createDemoAdapter, type DemoProfileName } from './providers/demo.js';
import { createGeminiAdapter } from './providers/gemini.js';
import { createOllamaAdapter } from './providers/ollama.js';
import { createOpenAiCompatibleAdapter } from './providers/openai.js';

export interface ResolveTargetOptions {
  targetSpec: string;
  model?: string;
  cmd?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Result of detectTargets(); saves resolving the binary and probing the CLI again. */
  detectedTargets?: TargetInfo[];
  /** PATH to search instead of process.env.PATH. */
  pathEnv?: string;
}

export interface ResolvedAdapter {
  adapter: SpeedtestAdapter;
  /**
   * The model to pass to the runner. For agent CLIs this is set only when the user named one
   * (`-m` or `target:model`), so the CLI's own configured model is used otherwise.
   */
  model?: string;
  tier: SupportTier;
}

export function parseTargetSpec(spec: string): { id: string; model?: string } {
  const colonIdx = spec.indexOf(':');
  if (colonIdx === -1) {
    return { id: spec.trim().toLowerCase() };
  }
  const id = spec.slice(0, colonIdx).trim().toLowerCase();
  const model = spec.slice(colonIdx + 1).trim();
  return { id, model: model || undefined };
}

async function locateHarnessBinary(
  entry: HarnessEntry,
  detected: TargetInfo | undefined,
  pathEnv: string | undefined
): Promise<string> {
  if (detected?.binaryPath) return detected.binaryPath;

  let miss: BinaryResolution | undefined;
  for (const command of entry.commands) {
    const resolution = await resolveBinary(command, { pathEnv });
    if (resolution.status === 'found' && resolution.path) return resolution.path;
    if (!miss || (miss.status === 'missing' && resolution.status !== 'missing')) miss = resolution;
  }
  // Never fall back to the bare command name: on a mise machine that would execute the shim.
  throw new TargetFailedError(
    `${entry.id}: ${describeMissingBinary(miss ?? { status: 'missing', path: null })}`,
    { kind: 'not_found' }
  );
}

async function resolveHarness(
  entry: HarnessEntry,
  opts: ResolveTargetOptions,
  model: string | undefined
): Promise<ResolvedAdapter> {
  const detected = opts.detectedTargets?.find((t) => t.id === entry.id);
  const binaryPath = await locateHarnessBinary(entry, detected, opts.pathEnv);
  const capability = await probeCapability(entry, binaryPath);
  if (!entry.create || !capability.ok) {
    throw new TargetFailedError(`${entry.id}: ${describeUnsupported(entry, capability)}`);
  }
  return {
    adapter: entry.create(binaryPath, { helpText: capability.helpText }),
    model: model && model !== 'default' ? model : undefined,
    tier: entry.tier,
  };
}

function resolveProvider(
  entry: ProviderEntry,
  opts: ResolveTargetOptions,
  model: string | undefined
): ResolvedAdapter {
  const detected = opts.detectedTargets?.find((t) => t.id === entry.id);
  const apiKey = opts.apiKey || providerApiKey(entry);
  const tier: SupportTier = 'verified';

  switch (entry.id) {
    case 'ollama': {
      const resolvedModel = model || detected?.defaultModel;
      return {
        adapter: createOllamaAdapter({ baseUrl: opts.baseUrl, defaultModel: resolvedModel }),
        model: resolvedModel,
        tier,
      };
    }
    case 'anthropic': {
      const resolvedModel = model || entry.defaultModel;
      return {
        adapter: createAnthropicAdapter({ apiKey, baseUrl: opts.baseUrl, defaultModel: resolvedModel }),
        model: resolvedModel,
        tier,
      };
    }
    case 'gemini-api': {
      const resolvedModel = model || entry.defaultModel;
      return {
        adapter: createGeminiAdapter({ apiKey, baseUrl: opts.baseUrl, defaultModel: resolvedModel }),
        model: resolvedModel,
        tier,
      };
    }
    default: {
      const resolvedModel = model || detected?.defaultModel || entry.defaultModel;
      if (!resolvedModel) {
        throw new TargetFailedError(
          `${entry.id}: no model is loaded; pass one as -t ${entry.id}:<model>`,
          { kind: 'model' }
        );
      }
      const baseUrl =
        opts.baseUrl ||
        (entry.id === 'openai' ? process.env.OPENAI_BASE_URL : undefined) ||
        entry.defaultBaseUrl;
      return {
        adapter: createOpenAiCompatibleAdapter({
          id: entry.id,
          name: entry.name,
          category: entry.category,
          baseUrl: baseUrl!,
          apiKey,
          requireApiKey: entry.envKeys.length > 0 ? entry.envKeys.join(' / ') : undefined,
          defaultModel: resolvedModel,
          extraHeaders:
            entry.id === 'openrouter'
              ? { 'HTTP-Referer': 'https://github.com/speedtest-ai', 'X-Title': 'speedtest-ai' }
              : undefined,
        }),
        model: resolvedModel,
        tier,
      };
    }
  }
}

/**
 * Turns a target spec (`claude`, `ollama:llama3.2`, `cmd`, ...) into an adapter, driven by the
 * catalog. Throws a TargetFailedError when the CLI is missing or has no usable adapter; it never
 * returns an adapter that would execute a mise shim.
 */
export async function resolveAdapter(opts: ResolveTargetOptions): Promise<ResolvedAdapter> {
  const parsed = parseTargetSpec(opts.targetSpec);
  const id = parsed.id;
  const model = opts.model || parsed.model;

  if (id === 'demo') {
    const profile = (model as DemoProfileName | undefined) ?? 'frontier';
    return { adapter: createDemoAdapter(profile), model: profile, tier: 'verified' };
  }

  if (id === 'cmd') {
    if (!opts.cmd) {
      throw new TargetFailedError('Target "cmd" requires --cmd "<command template>"');
    }
    const adapter = createCustomCmdAdapter(opts.cmd);
    return { adapter, model: model || 'custom-cmd', tier: adapter.tier };
  }

  const harness = findHarnessEntry(id);
  if (harness) {
    try {
      return await resolveHarness(harness, opts, model);
    } catch (err) {
      if (id === 'gemini' && err instanceof TargetFailedError && err.kind === 'not_found') {
        throw new TargetFailedError(`${err.message}. For the Gemini API use -t gemini-api[:model].`, {
          kind: 'not_found',
        });
      }
      throw err;
    }
  }

  const provider = findProviderEntry(id);
  if (provider) return resolveProvider(provider, opts, model);

  if (opts.baseUrl) {
    const resolvedModel = model || 'default';
    return {
      adapter: createOpenAiCompatibleAdapter({
        id,
        name: `OpenAI-Compatible (${id})`,
        category: 'provider',
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey || process.env.OPENAI_API_KEY,
        defaultModel: resolvedModel,
      }),
      model: resolvedModel,
      tier: 'verified',
    };
  }

  throw new TargetFailedError(
    `Unknown target "${opts.targetSpec}". Run "speedtest-ai detect" to see available targets.`,
    { kind: 'not_found' }
  );
}
