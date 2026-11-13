export interface SseFrame {
  event?: string;
  data: string;
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseFrame, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

  const flushFrame = (): SseFrame | null => {
    if (dataLines.length === 0) {
      currentEvent = undefined;
      return null;
    }
    const data = dataLines.join('\n');
    const frame: SseFrame = { event: currentEvent, data };
    currentEvent = undefined;
    dataLines = [];
    return frame;
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
            if (frame.data.trim() === '[DONE]') return;
            yield frame;
          }
        } else if (line.startsWith(':')) {
          // SSE comment / keepalive
        } else if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }

        newlineIdx = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const rawLine of buffer.split(/\r?\n/)) {
        if (rawLine.startsWith('event:')) {
          currentEvent = rawLine.slice(6).trim();
        } else if (rawLine.startsWith('data:')) {
          dataLines.push(rawLine.slice(5).trimStart());
        }
      }
    }
    const lastFrame = flushFrame();
    if (lastFrame && lastFrame.data.trim() !== '[DONE]') {
      yield lastFrame;
    }
  } finally {
    reader.releaseLock();
  }
}
