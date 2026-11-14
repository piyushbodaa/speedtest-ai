import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';
import { asCount, asRecord, asText, cliFailure, sumCounts } from './shared-json-parser.js';

/** Our phase timeout must fire first, so the CLI's own print timeout gets this much slack. */
const PRINT_TIMEOUT_SLACK_S = 5;

export interface AgyParserOptions {
  /** Label used when the init event carries no model (agy only echoes an explicit --model). */
  fallbackModel?: string;
}

export interface AgyAdapterOptions {
  /** Antigravity CLI settings file; read only for the configured model's display name. */
  settingsPath?: string;
}

export function defaultAgySettingsPath(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

/** The user's configured model as agy stores it (a display name such as "Orchestrator (Carbon)"). */
export function readAgyConfiguredModel(settingsPath = defaultAgySettingsPath()): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return asText(asRecord(parsed)?.model);
  } catch {
    return undefined;
  }
}

/**
 * Parser for `agy -p --output-format stream-json`.
 * Terminal event: `{"event":"result","result":{"status":"SUCCESS",...}}`.
 */
export function createAgyEventParser(
  options: AgyParserOptions = {}
): (ev: unknown) => AdapterStreamChunk[] {
  let sawText = false;
  const announcedToolSteps = new Set<unknown>();

  return (raw: unknown): AdapterStreamChunk[] => {
    const ev = asRecord(raw);
    if (!ev) return [];

    if (ev.event === 'init') {
      return [{ kind: 'init', model: asText(asRecord(ev.init)?.model) ?? options.fallbackModel }];
    }

    if (ev.event === 'step_update') {
      const step = asRecord(ev.step_update);
      if (!step) return [];
      const chunks: AdapterStreamChunk[] = [];
      const stepType = asText(step.step_type);

      if (stepType && stepType !== 'user_input' && stepType !== 'agent_response') {
        // A tool step sends an ACTIVE and a DONE update; count it once.
        const toolName = asText(step.tool_name) ?? stepType;
        const key = step.step_index ?? toolName;
        if (!announcedToolSteps.has(key)) {
          announcedToolSteps.add(key);
          chunks.push({ kind: 'tool_call', toolName });
        }
        if (step.state === 'DONE') chunks.push({ kind: 'tool_result', toolName });
        return chunks;
      }

      const thinking = asText(step.thinking_delta);
      if (thinking) chunks.push({ kind: 'thinking', text: thinking });
      const text = asText(step.text_delta);
      if (text) {
        sawText = true;
        chunks.push({ kind: 'text', text });
      }
      return chunks;
    }

    if (ev.event === 'result') {
      const result = asRecord(ev.result);
      if (!result || result.status !== 'SUCCESS') {
        throw cliFailure(
          'agy',
          asText(result?.error),
          `run ended with status ${asText(result?.status) ?? 'unknown'}`
        );
      }

      const chunks: AdapterStreamChunk[] = [];
      const response = asText(result.response);
      if (!sawText && response) {
        sawText = true;
        chunks.push({ kind: 'text', text: response });
      }

      const usage = asRecord(result.usage);
      const durationSeconds = asCount(result.duration_seconds);
      chunks.push({
        kind: 'terminal',
        inputTokens: sumCounts(usage?.input_tokens, usage?.cache_read_tokens),
        cachedInputTokens: asCount(usage?.cache_read_tokens),
        outputTokens: asCount(usage?.output_tokens),
        reasoningTokens: asCount(usage?.thinking_tokens),
        apiDurationMs: durationSeconds === undefined ? undefined : Math.round(durationSeconds * 1000),
      });
      return chunks;
    }

    return [];
  };
}

export function buildAgyArgs(req: AdapterInvokeRequest): string[] {
  const args = ['-p', req.prompt, '--output-format', 'stream-json'];
  if (!req.asConfigured) args.push('--disable-slash-commands');
  if (req.timeoutMs !== undefined && req.timeoutMs > 0) {
    // Go-style duration; keeps a permission prompt from hanging a headless run forever.
    args.push('--print-timeout', `${Math.ceil(req.timeoutMs / 1000) + PRINT_TIMEOUT_SLACK_S}s`);
  }
  // Only the tool loop needs to run a tool unattended, and it runs inside the temp probe dir.
  if (req.enableReadTool) args.push('--dangerously-skip-permissions');
  if (req.model && req.model !== 'default') args.push('--model', req.model);
  return args;
}

export function createAgyAdapter(binaryPath = 'agy', options: AgyAdapterOptions = {}): SpeedtestAdapter {
  return {
    id: 'agy',
    name: 'Antigravity CLI',
    category: 'harness',
    tier: 'verified',
    supportsToolLoop: true,
    toolLoopBypassesPermissions: true,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      const fallbackModel =
        req.model && req.model !== 'default' ? req.model : readAgyConfiguredModel(options.settingsPath);
      yield* runNdjsonHarness({
        binaryPath,
        label: 'agy',
        req,
        createParser: () => createAgyEventParser({ fallbackModel }),
        buildArgs: () => buildAgyArgs(req),
      });
    },
  };
}
