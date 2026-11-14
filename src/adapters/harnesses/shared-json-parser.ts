import { classifyFailureKind, TargetFailedError } from '../../core/errors.js';
import type { AdapterStreamChunk } from '../../types.js';

/** Small typed accessors shared by the harness event parsers (agy, grok, muse). */
export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Sum of the values that are present; undefined when none is. */
export function sumCounts(...values: unknown[]): number | undefined {
  let total: number | undefined;
  for (const value of values) {
    const n = asCount(value);
    if (n !== undefined) total = (total ?? 0) + n;
  }
  return total;
}

/**
 * Builds the error for a CLI's own error event. Only the first line of the CLI's message is kept
 * (agy appends its whole model list), but the failure kind is classified from the full text.
 */
export function cliFailure(label: string, message: string | undefined, fallback: string): TargetFailedError {
  const full = (message ?? '').trim();
  const firstLine = full.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return new TargetFailedError(`${label}: ${firstLine || fallback}`, {
    kind: classifyFailureKind(full),
  });
}

/**
 * Passes a harness stream through and attaches caveats to the result. The notes are sent right
 * after the first event from the CLI, so they never count as the "CLI ready" moment themselves.
 */
export async function* withNotes(
  stream: AsyncGenerator<AdapterStreamChunk, void, unknown>,
  notes: string[]
): AsyncGenerator<AdapterStreamChunk, void, unknown> {
  let sent = notes.length === 0;
  for await (const chunk of stream) {
    yield chunk;
    if (!sent && chunk.kind !== 'start') {
      sent = true;
      for (const text of notes) yield { kind: 'note', text };
    }
  }
}
