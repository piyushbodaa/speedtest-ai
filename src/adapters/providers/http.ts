import { limitResponseBody } from '../utils/response-limit.js';
import {
  abortErrorFromSignal,
  classifyFailureKind,
  type FailureKind,
  TargetFailedError,
  toTypedError,
} from '../../core/errors.js';
import type { AdapterStreamChunk } from '../../types.js';

/** Floor for providers whose hidden reasoning is charged against the output cap. */
export const REASONING_HEADROOM_TOKENS = 4096;

function kindForStatus(status: number, body: string): FailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  const fromBody = classifyFailureKind(body);
  if (fromBody !== 'other') return fromBody;
  // A 404 from a chat endpoint is almost always an unknown model name.
  return status === 404 ? 'model' : 'other';
}

function errorDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const data = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const err = data.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      return (err as { message: string }).message;
    }
    if (typeof data.message === 'string') return data.message;
  } catch {
    // Not JSON; use the raw text.
  }
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
}

export function httpFailure(name: string, status: number, statusText: string, body: string): TargetFailedError {
  const detail = errorDetail(body) || statusText;
  return new TargetFailedError(`${name} HTTP ${status}${detail ? `: ${detail}` : ''}`, {
    kind: kindForStatus(status, body),
  });
}

export function missingKeyError(name: string, envNames: string): TargetFailedError {
  return new TargetFailedError(`${name}: no API key (set ${envNames} or pass --api-key)`, { kind: 'auth' });
}

export function streamErrorEvent(name: string, message: string, kind?: FailureKind): TargetFailedError {
  return new TargetFailedError(`${name}: ${message}`, { kind: kind ?? classifyFailureKind(message) });
}

export function truncatedStreamError(name: string): TargetFailedError {
  return new TargetFailedError(`${name}: the stream ended before the response was complete`);
}

/**
 * Sends a streaming POST. Network failures become a TargetFailedError; an abort surfaces as the
 * signal's own timeout / interrupt error. The response is returned whatever its status.
 */
export async function postForStream(
  name: string,
  url: string,
  init: { headers: Record<string, string>; body: string },
  signal: AbortSignal
): Promise<Response> {
  try {
    let destination = new URL(url);
    const headers = new Headers(init.headers);
    let method = 'POST';
    let body: string | undefined = init.body;

    for (let hops = 0; ; hops++) {
      const response = await fetch(destination, { method, headers, body, redirect: 'manual', signal });
      const location = response.headers.get('location');
      if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return response;

      await response.body?.cancel();
      const next = new URL(location, destination);
      if (next.origin !== destination.origin || next.username || next.password) {
        throw new Error('provider redirect left the configured origin');
      }
      if (hops >= 20) throw new Error('too many provider redirects');
      if (method === 'POST' && [301, 302, 303].includes(response.status)) {
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
      }
      destination = next;
    }
  } catch (err) {
    if (signal.aborted) throw abortErrorFromSignal(signal);
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    const message = err instanceof Error ? err.message : String(err);
    throw new TargetFailedError(`${name}: request failed (${message}${cause})`, { cause: err });
  }
}

export async function ensureOk(name: string, res: Response): Promise<ReadableStream<Uint8Array>> {
  if (res.ok && res.body) return limitResponseBody(res.body, 16 * 1024 * 1024);
  const body = res.body
    ? await new Response(limitResponseBody(res.body, 64 * 1024)).text().catch(() => '')
    : '';
  throw httpFailure(name, res.status, res.statusText, body);
}

/**
 * Wraps a provider's chunk stream so that a read error caused by an abort is reported as the
 * abort, and any other failure as a TargetFailedError.
 */
export async function* guardStream(
  signal: AbortSignal,
  source: AsyncGenerator<AdapterStreamChunk, void, unknown>
): AsyncGenerator<AdapterStreamChunk, void, unknown> {
  try {
    yield* source;
  } catch (err) {
    if (signal.aborted) throw abortErrorFromSignal(signal);
    throw toTypedError(err);
  }
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseJsonObject(data: string): Record<string, any> | undefined {
  if (!data) return undefined;
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}
