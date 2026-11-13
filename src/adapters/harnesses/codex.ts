import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';

export function createCodexEventParser(): (ev: unknown) => AdapterStreamChunk[] {
  const seenLengths = new Map<string, number>();

  return (raw: unknown): AdapterStreamChunk[] => {
    if (!raw || typeof raw !== 'object') return [];
    const ev = raw as Record<string, any>;
    const chunks: AdapterStreamChunk[] = [];

    if (ev.type === 'thread.started') {
      chunks.push({
        kind: 'init',
        model: typeof ev.model === 'string' ? ev.model : undefined,
      });
      return chunks;
    }

    if (
      (ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed') &&
      ev.item &&
      typeof ev.item === 'object'
    ) {
      const item = ev.item as Record<string, any>;
      const itemId = typeof item.id === 'string' ? item.id : 'default';

      if (ev.type === 'item.started' && item.type === 'command_execution') {
        chunks.push({ kind: 'tool_call', toolName: 'shell' });
      }

      if ((item.type === 'agent_message' || item.type === 'reasoning') && typeof item.text === 'string') {
        const prev = seenLengths.get(itemId) ?? 0;
        if (item.text.length > prev) {
          const delta = item.text.slice(prev);
          seenLengths.set(itemId, item.text.length);
          chunks.push({
            kind: item.type === 'reasoning' ? 'thinking' : 'text',
            text: delta,
          });
        }
      }
      return chunks;
    }

    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      const usage = ev.usage as Record<string, any>;
      chunks.push({
        kind: 'usage',
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
        cachedInputTokens:
          typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : undefined,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
      });
      return chunks;
    }

    return chunks;
  };
}

export function createCodexAdapter(binaryPath = 'codex'): SpeedtestAdapter {
  return {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    category: 'harness',
    supportsToolLoop: true,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      yield* runNdjsonHarness({
        binaryPath,
        label: 'codex',
        req,
        createParser: createCodexEventParser,
        buildArgs: (effectiveCwd) => {
          const args = [
            'exec',
            '--json',
            '--ephemeral',
            '--skip-git-repo-check',
            '-s',
            'read-only',
            '-C',
            effectiveCwd,
          ];
          if (req.model && req.model !== 'default') {
            args.push('-m', req.model);
          }
          args.push('--', req.prompt);
          return args;
        },
      });
    },
  };
}
