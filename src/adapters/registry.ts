import { resolveRealBinary } from '../core/detect.js';
import type { SpeedtestAdapter, TargetInfo } from '../types.js';
import { createAgyAdapter } from './harnesses/agy.js';
import { createClaudeAdapter } from './harnesses/claude.js';
import { createCodexAdapter } from './harnesses/codex.js';
import { createCustomCmdAdapter } from './harnesses/custom-cmd.js';
import { createGrokAdapter } from './harnesses/grok.js';
import { createMuseAdapter } from './harnesses/muse.js';
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
  detectedTargets?: TargetInfo[];
}

export interface ResolvedAdapter {
  adapter: SpeedtestAdapter;
  model?: string;
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

export async function resolveAdapter(opts: ResolveTargetOptions): Promise<ResolvedAdapter> {
  const parsed = parseTargetSpec(opts.targetSpec);
  const id = parsed.id;
  const model = opts.model || parsed.model;
  const detected = opts.detectedTargets?.find((t) => t.id === id);

  switch (id) {
    case 'demo': {
      const profile = (model as DemoProfileName | undefined) ?? 'frontier';
      return {
        adapter: createDemoAdapter(profile),
        model: profile,
      };
    }

    case 'claude': {
      const bin = detected?.binaryPath || (await resolveRealBinary('claude')) || 'claude';
      return { adapter: createClaudeAdapter(bin), model };
    }

    case 'codex': {
      const bin = detected?.binaryPath || (await resolveRealBinary('codex')) || 'codex';
      return { adapter: createCodexAdapter(bin), model };
    }

    case 'agy': {
      const bin = detected?.binaryPath || (await resolveRealBinary('agy')) || 'agy';
      return { adapter: createAgyAdapter(bin), model };
    }

    case 'grok': {
      const bin = detected?.binaryPath || (await resolveRealBinary('grok')) || 'grok';
      return { adapter: createGrokAdapter(bin), model };
    }

    case 'muse': {
      const bin = detected?.binaryPath || (await resolveRealBinary('muse')) || 'muse';
      return { adapter: createMuseAdapter(bin), model };
    }

    case 'cmd': {
      if (!opts.cmd) {
        throw new Error('Target "cmd" requires --cmd "<command template>"');
      }
      return { adapter: createCustomCmdAdapter(opts.cmd), model: model || 'custom-cmd' };
    }

    case 'ollama': {
      const resolvedModel = model || detected?.defaultModel;
      return {
        adapter: createOllamaAdapter({
          baseUrl: opts.baseUrl,
          defaultModel: resolvedModel,
        }),
        model: resolvedModel,
      };
    }

    case 'lmstudio': {
      const resolvedModel = model || detected?.defaultModel || 'local-model';
      return {
        adapter: createOpenAiCompatibleAdapter({
          id: 'lmstudio',
          name: 'LM Studio (Local)',
          category: 'local',
          baseUrl: opts.baseUrl || 'http://127.0.0.1:1234/v1',
          apiKey: opts.apiKey,
          defaultModel: resolvedModel,
        }),
        model: resolvedModel,
      };
    }

    case 'openai': {
      const resolvedModel = model || 'gpt-4.1-mini';
      return {
        adapter: createOpenAiCompatibleAdapter({
          id: 'openai',
          name: 'OpenAI API',
          category: 'provider',
          baseUrl: opts.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
          apiKey: opts.apiKey || process.env.OPENAI_API_KEY,
          defaultModel: resolvedModel,
        }),
        model: resolvedModel,
      };
    }

    case 'openrouter': {
      const resolvedModel = model || 'openai/gpt-4.1-mini';
      return {
        adapter: createOpenAiCompatibleAdapter({
          id: 'openrouter',
          name: 'OpenRouter API',
          category: 'provider',
          baseUrl: opts.baseUrl || 'https://openrouter.ai/api/v1',
          apiKey: opts.apiKey || process.env.OPENROUTER_API_KEY,
          defaultModel: resolvedModel,
          extraHeaders: {
            'HTTP-Referer': 'https://github.com/speedtest-ai',
            'X-Title': 'speedtest-ai',
          },
        }),
        model: resolvedModel,
      };
    }

    case 'anthropic': {
      const resolvedModel = model || 'claude-sonnet-4-20250514';
      return {
        adapter: createAnthropicAdapter({
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
          defaultModel: resolvedModel,
        }),
        model: resolvedModel,
      };
    }

    case 'gemini': {
      const resolvedModel = model || 'gemini-2.5-flash';
      return {
        adapter: createGeminiAdapter({
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
          defaultModel: resolvedModel,
        }),
        model: resolvedModel,
      };
    }

    default: {
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
        };
      }
      throw new Error(
        `Unknown target "${opts.targetSpec}". Run "speedtest-ai detect" to see available targets.`
      );
    }
  }
}
