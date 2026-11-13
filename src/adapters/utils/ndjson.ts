export async function* parseNdjsonStream(
  readable: NodeJS.ReadableStream
): AsyncGenerator<unknown, void, unknown> {
  let buffer = '';

  for await (const chunk of readable) {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, '').trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) {
        try {
          yield JSON.parse(line);
        } catch {
          // Ignore non-JSON preamble/diagnostic lines safely
        }
      }
      newlineIdx = buffer.indexOf('\n');
    }
  }

  const tail = buffer.replace(/\r$/, '').trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch {
      // Ignore trailing partial/non-JSON line
    }
  }
}
