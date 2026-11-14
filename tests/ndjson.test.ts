import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NdjsonLineDecoder, parseNdjsonStream } from '../src/adapters/utils/ndjson.js';

async function collect(chunks: Array<Buffer | string>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const value of parseNdjsonStream(Readable.from(chunks, { objectMode: true }))) {
    out.push(value);
  }
  return out;
}

describe('NDJSON decoding', () => {
  it('keeps multi-byte characters that are split across chunks', async () => {
    const line = Buffer.from('{"t":"café € 你好 🚀"}\n', 'utf8');
    // Every possible split point, including the middle of each multi-byte sequence.
    for (let cut = 1; cut < line.length; cut++) {
      const values = await collect([line.subarray(0, cut), line.subarray(cut)]);
      expect(values).toEqual([{ t: 'café € 你好 🚀' }]);
    }
  });

  it('survives one byte per chunk', async () => {
    const line = Buffer.from('{"t":"naïve 🚀"}\n{"n":2}\n', 'utf8');
    const values = await collect([...line].map((byte) => Buffer.from([byte])));
    expect(values).toEqual([{ t: 'naïve 🚀' }, { n: 2 }]);
  });

  it('skips non-JSON lines, blank lines and CRLF endings', async () => {
    const values = await collect([
      'Reading additional input from stdin...\n',
      '\n',
      '{"a":1}\r\n',
      '{broken json\n',
      '[warn] not json\n',
      '  {"b":2}  \n',
    ]);
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('yields a final line that has no trailing newline', async () => {
    expect(await collect(['{"a":1}\n{"b"', ':2}'])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('decoder returns values as soon as their line completes', () => {
    const decoder = new NdjsonLineDecoder();
    expect(decoder.push('{"a":')).toEqual([]);
    expect(decoder.push('1}\n{"b":2}\n{"c"')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(decoder.push(':3}')).toEqual([]);
    expect(decoder.flush()).toEqual([{ c: 3 }]);
  });
});
