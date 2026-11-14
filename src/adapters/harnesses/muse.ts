import { isTargetFailedError, TargetFailedError } from '../../core/errors.js';
import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runNdjsonHarness } from './run-ndjson-harness.js';
import { asCount, asRecord, asText, cliFailure, withNotes } from './shared-json-parser.js';

/** Used only when `muse exec` rejects the model configured in the user's settings. */
export const MUSE_FALLBACK_MODEL = 'muse-spark-1.3';

export const MUSE_LEAN_NOTE = 'muse: lean mode runs with --reasoning-effort low';

const MODEL_REJECTED_RE = /does not exist or you lack access/i;

export function museFallbackNote(rejectedModel: string | undefined): string {
  const what = rejectedModel ? `configured default model ${rejectedModel}` : 'configured default model';
  return `muse: the ${what} was rejected by muse exec; measured ${MUSE_FALLBACK_MODEL} instead`;
}

function providerStream(event: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const details = asRecord(event?.details);
  if (details?.phase !== 'stream_succeeded' || !Array.isArray(details.facets)) return undefined;
  for (const facet of details.facets) {
    const stream = asRecord(asRecord(asRecord(facet)?.detail)?.stream);
    if (stream) return stream;
  }
  return undefined;
}

/**
 * Parser for `muse exec --json` envelopes (`{payload_type, payload}`).
 * Terminal event: `run.terminal.completed`; any other `run.terminal.*` is a failure.
 */
export function createMuseEventParser(): (ev: unknown) => AdapterStreamChunk[] {
  let sawText = false;
  let modelCalls: number | undefined;
  let sentProviderTiming = false;

  return (raw: unknown): AdapterStreamChunk[] => {
    const ev = asRecord(raw);
    const type = asText(ev?.payload_type);
    const payload = asRecord(ev?.payload);
    if (!type || !payload) return [];

    if (type === 'run.model.configured') {
      return [{ kind: 'init', model: asText(payload.model_id) ?? asText(payload.display_label) }];
    }

    if (type === 'run.output.delta') {
      const text = asText(payload.text);
      if (!text) return [];
      sawText = true;
      return [{ kind: 'text', text }];
    }

    if (type === 'task.lifecycle.proposed') {
      const taskKind = asText(asRecord(payload.event)?.task_kind);
      return taskKind?.startsWith('tool.')
        ? [{ kind: 'tool_call', toolName: taskKind.slice('tool.'.length) }]
        : [];
    }

    if (type === 'tool.result') {
      return [{ kind: 'tool_result', toolName: asText(asRecord(payload.correlation_facts)?.tool_name) }];
    }

    if (type === 'task.lifecycle.status') {
      // The provider's own latency for the first model call; informational only.
      const stream = sentProviderTiming ? undefined : providerStream(asRecord(payload.event));
      if (!stream) return [];
      const extra: Record<string, number> = {};
      const ttft = asCount(stream.time_to_first_token_ms);
      const firstEvent = asCount(stream.time_to_first_event_ms);
      if (ttft !== undefined) extra.providerTtftMs = ttft;
      if (firstEvent !== undefined) extra.providerFirstEventMs = firstEvent;
      if (Object.keys(extra).length === 0) return [];
      sentProviderTiming = true;
      return [{ kind: 'meta', extra }];
    }

    if (type === 'run.usage') {
      modelCalls = asCount(payload.calls);
      const models = Array.isArray(payload.models) ? payload.models.map(asRecord) : [];
      if (models.length === 0) return [];
      let input = 0;
      let cached = 0;
      let output = 0;
      let reasoning = 0;
      for (const m of models) {
        // muse's input_tokens already includes cached_tokens.
        input += asCount(m?.input_tokens) ?? 0;
        cached += asCount(m?.cached_tokens) ?? 0;
        output += asCount(m?.output_tokens) ?? 0;
        reasoning += asCount(m?.reasoning_tokens) ?? 0;
      }
      return [
        {
          kind: 'usage',
          inputTokens: input,
          cachedInputTokens: cached,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
      ];
    }

    if (type === 'run.terminal.completed') {
      // muse answers trivial prompts with a canned local reply and never calls the model.
      if (modelCalls === 0) {
        throw new TargetFailedError('muse: answered without calling the model (canned local reply)');
      }
      const chunks: AdapterStreamChunk[] = [];
      const finalText = asText(payload.text);
      if (!sawText && finalText) {
        sawText = true;
        chunks.push({ kind: 'text', text: finalText });
      }
      chunks.push({ kind: 'terminal' });
      return chunks;
    }

    if (type.startsWith('run.terminal.')) {
      // The provider request id is noise in a one-line error.
      const reason = asText(payload.reason)?.replace(/\s*\[request_id=[^\]]*\]/g, '');
      throw cliFailure('muse', reason, `run ended as ${type.slice('run.terminal.'.length)}`);
    }

    return [];
  };
}

export function buildMuseArgs(
  req: AdapterInvokeRequest,
  effectiveCwd: string,
  model: string | undefined
): string[] {
  // Reminder agents only add seconds of bookkeeping after the answer; session logs are litter.
  const args = ['exec', '--json', '--disable-reminders', '--no-session-log'];
  if (!req.asConfigured) {
    args.push('--disable-web-tools', '--no-foreign-personal-context', '--reasoning-effort', 'low');
  }
  if (req.enableReadTool) args.push('--workspace', effectiveCwd);
  else if (!req.asConfigured) args.push('--preset', 'empty');
  if (model) args.push('--model', model);
  args.push('--', req.prompt);
  return args;
}

export function createMuseAdapter(binaryPath = 'muse'): SpeedtestAdapter {
  // Set once `muse exec` has refused the configured default, so later phases skip the dead attempt.
  let defaultRejected = false;
  let rejectedModel: string | undefined;

  return {
    id: 'muse',
    name: 'Muse Code CLI',
    category: 'harness',
    tier: 'verified',
    supportsToolLoop: true,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      const leanNotes = req.asConfigured ? [] : [MUSE_LEAN_NOTE];
      const run = (model: string | undefined) =>
        runNdjsonHarness({
          binaryPath,
          label: 'muse',
          req,
          createParser: createMuseEventParser,
          buildArgs: (effectiveCwd) => buildMuseArgs(req, effectiveCwd, model),
        });

      const explicitModel = req.model && req.model !== 'default' ? req.model : undefined;
      if (explicitModel) {
        yield* withNotes(run(explicitModel), leanNotes);
        return;
      }

      if (!defaultRejected) {
        let sawContent = false;
        try {
          for await (const chunk of withNotes(run(undefined), leanNotes)) {
            if (chunk.kind === 'text' || chunk.kind === 'thinking') sawContent = true;
            yield chunk;
          }
          return;
        } catch (err) {
          const rejected =
            !sawContent &&
            !req.signal.aborted &&
            isTargetFailedError(err) &&
            MODEL_REJECTED_RE.test(err.message);
          if (!rejected) throw err;
          defaultRejected = true;
          rejectedModel = /model [`'"]([^`'"]+)[`'"]/.exec((err as Error).message)?.[1];
        }
      }

      yield* withNotes(run(MUSE_FALLBACK_MODEL), [...leanNotes, museFallbackNote(rejectedModel)]);
    },
  };
}
