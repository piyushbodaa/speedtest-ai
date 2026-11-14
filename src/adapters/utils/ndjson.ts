import { StringDecoder } from 'node:string_decoder';

/**
 * Incremental NDJSON decoder. Bytes go through one streaming UTF-8 decoder, so a multi-byte
 * character split across two chunks survives. Lines that are not JSON (banners, diagnostics)
 * are skipped.
 */
export class NdjsonLineDecoder {
  private decoder = new StringDecoder('utf8');
  private buffer = '';

  /** Returns the JSON values completed by this chunk. */
  push(chunk: Buffer | Uint8Array | string): unknown[] {
    this.buffer +=
      typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const values: unknown[] = [];
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.parseLine(line, values);
      newlineIdx = this.buffer.indexOf('\n');
    }
    return values;
  }

  /** Call at end of input: returns the value of a final line that had no trailing newline. */
  flush(): unknown[] {
    this.buffer += this.decoder.end();
    const values: unknown[] = [];
    this.parseLine(this.buffer, values);
    this.buffer = '';
    return values;
  }

  private parseLine(raw: string, out: unknown[]): void {
    const line = raw.trim();
    if (!line) return;
    const first = line.charCodeAt(0);
    // '{' or '[': every event stream this tool reads is made of objects; skip the rest cheaply.
    if (first !== 123 && first !== 91) return;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Not JSON: a diagnostic line that happened to start with a brace.
    }
  }
}

export async function* parseNdjsonStream(
  readable: AsyncIterable<Buffer | Uint8Array | string>
): AsyncGenerator<unknown, void, unknown> {
  const decoder = new NdjsonLineDecoder();
  for await (const chunk of readable) {
    yield* decoder.push(chunk);
  }
  yield* decoder.flush();
}
