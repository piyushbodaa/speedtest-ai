export interface SseFrame {
  event?: string;
  data: string;
}

export interface SseParseOptions {
  /**
   * Yield the `[DONE]` sentinel as a frame before stopping, so the caller can tell a finished
   * stream from one that was cut off. Off by default: the sentinel just ends the iteration.
   */
  emitDone?: boolean;
}

export const SSE_DONE = '[DONE]';

/**
 * Incremental Server-Sent Events reader. Multi-byte characters split across network chunks are
 * decoded correctly, and the connection is cancelled when the consumer stops early.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  options: SseParseOptions = {}
): AsyncGenerator<SseFrame, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentEvent: string | undefined;
  let dataLines: string[] = [];
  let finished = false;

  const flushFrame = (): SseFrame | null => {
    if (dataLines.length === 0) {
      currentEvent = undefined;
      return null;
    }
    const frame: SseFrame = { event: currentEvent, data: dataLines.join('\n') };
    currentEvent = undefined;
    dataLines = [];
    return frame;
  };

  const takeField = (line: string) => {
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // The spec strips exactly one leading space.
      dataLines.push(line.charAt(5) === ' ' ? line.slice(6) : line.slice(5));
    }
    // Comments (":keepalive"), `id:` and `retry:` carry nothing we need.
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf('\n');

      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);

        if (line === '') {
          const frame = flushFrame();
          if (frame) {
            if (frame.data.trim() === SSE_DONE) {
              if (options.emitDone) yield { event: frame.event, data: SSE_DONE };
              return;
            }
            yield frame;
          }
        } else {
          takeField(line);
        }

        newlineIdx = buffer.indexOf('\n');
      }
    }
    finished = true;

    buffer += decoder.decode();
    for (const rawLine of buffer.split(/\r?\n/)) {
      if (rawLine) takeField(rawLine);
    }
    const lastFrame = flushFrame();
    if (lastFrame) {
      if (lastFrame.data.trim() !== SSE_DONE) yield lastFrame;
      else if (options.emitDone) yield { event: lastFrame.event, data: SSE_DONE };
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
