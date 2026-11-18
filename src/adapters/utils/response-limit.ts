// The benchmark requests short answers. Bound decoded bytes before any framing or JSON parsing.
export function limitResponseBody(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error('response exceeded the byte limit');
      controller.enqueue(chunk);
    },
  }));
}
