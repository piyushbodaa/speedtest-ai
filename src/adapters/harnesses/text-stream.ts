import { TargetFailedError } from '../../core/errors.js';
import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { runTextHarness } from './run-ndjson-harness.js';

export interface TextStreamArgContext {
  prompt: string;
  /** Only set when the user passed -m and the CLI has a model flag. */
  model?: string;
  /** True when the CLI's help text mentions `flag` (for flags that are nice to have, not required). */
  has: (flag: string) => boolean;
}

export interface TextStreamAdapterOptions {
  id: string;
  name: string;
  binaryPath: string;
  buildArgs: (ctx: TextStreamArgContext) => string[];
  /** Help text captured by the capability probe; backs `has()`. */
  helpText?: string;
  /** The flag that selects a model. Without it (or when the help text lacks it) -m is rejected. */
  modelFlag?: string;
  /** Remove terminal escape sequences from stdout before counting it as text. */
  stripAnsi?: boolean;
  env?: NodeJS.ProcessEnv;
  notes?: string[];
}

// CSI, OSC (BEL or ST terminated) and two-character escapes.
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// An escape sequence that has started but whose final byte has not arrived yet.
const PARTIAL_ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*\u001b?)?$/;

/** Strips escape sequences from a stream of chunks, holding back a sequence split across two chunks. */
export class AnsiStripper {
  private carry = '';

  push(chunk: string): string {
    let text = this.carry + chunk;
    this.carry = '';
    const partial = PARTIAL_ANSI_RE.exec(text);
    if (partial && partial[0].length > 0) {
      this.carry = partial[0];
      text = text.slice(0, partial.index);
    }
    return text.replace(ANSI_RE, '').replace(/\r(?!\n)/g, '');
  }

  flush(): string {
    const rest = this.carry;
    this.carry = '';
    // An unfinished escape at the very end is terminal noise, not answer text.
    return rest.startsWith('\u001b') ? '' : rest;
  }
}

/**
 * Generic adapter for a CLI whose headless mode prints the answer as plain text: raw stdout
 * chunks are the visible text and exit code 0 is success. Runs in an empty temp directory.
 *
 * Leading whitespace is held back so a blank line printed at startup does not count as the first
 * token. No vendor usage is available; a CLI that prints everything at once is reported as buffered
 * by the runner's streaming rule.
 */
export function createTextStreamAdapter(options: TextStreamAdapterOptions): SpeedtestAdapter {
  const help = options.helpText ?? '';
  const has = (flag: string) => help.includes(flag);
  const modelSupported = Boolean(options.modelFlag) && (help === '' || has(options.modelFlag!));

  return {
    id: options.id,
    name: options.name,
    category: 'harness',
    tier: 'experimental',
    supportsToolLoop: false,
    notes: [
      'experimental: plain-text mode, timing from stdout, no vendor token counts',
      "runs with the CLI's own configuration; only the working directory is isolated",
      ...(options.notes ?? []),
    ],
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      if (req.model && !modelSupported) {
        throw new TargetFailedError(
          `${options.id}: this CLI has no model flag speedtest-ai can use; run it without -m to test its configured model`,
          { kind: 'model' }
        );
      }
      const args = options.buildArgs({ prompt: req.prompt, model: req.model, has });
      const stripper = options.stripAnsi ? new AnsiStripper() : undefined;
      let sawText = false;

      const emit = (raw: string): AdapterStreamChunk | undefined => {
        let text = stripper ? stripper.push(raw) : raw;
        if (!sawText) text = text.trimStart();
        if (!text) return undefined;
        sawText = true;
        return { kind: 'text', text };
      };

      for await (const chunk of runTextHarness({
        binaryPath: options.binaryPath,
        label: options.id,
        req,
        buildArgs: () => args,
        env: options.env,
      })) {
        if (chunk.kind !== 'text') {
          yield chunk;
          continue;
        }
        const out = emit(chunk.text ?? '');
        if (out) yield out;
      }

      const rest = stripper?.flush();
      if (rest) {
        const out = emit(rest);
        if (out) yield out;
      }
      if (!sawText) {
        throw new TargetFailedError(`${options.id} exited successfully but printed no answer`);
      }
    },
  };
}
