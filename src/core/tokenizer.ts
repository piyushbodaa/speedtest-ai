/**
 * "Normalized tokens": one cheap, deterministic estimator applied to the visible text, identical
 * for every target. It is NOT any vendor's tokenizer (those differ by up to ~45% on the same
 * text); it exists so that tokens/sec is comparable between CLIs.
 *
 * Rules: a word (with its leading space) is 1 token, digits count in groups of 3, a run of
 * punctuation is 1 token, whitespace runs are 1 token per 4 characters, and non-ASCII runs count
 * 1 token per 2.5 UTF-8 bytes.
 */
const SEGMENT_RE =
  /'(?:s|t|re|ve|m|ll|d)| ?[A-Za-z]+| ?[0-9]{1,3}| ?[^\sA-Za-z0-9\x00-\x7F]+| ?[^\sA-Za-z0-9]+|\s+/gi;

function countSegments(text: string): number {
  let count = 0;
  const matches = text.match(SEGMENT_RE);
  if (!matches) return 0;

  for (const seg of matches) {
    const trimmed = seg.trim();
    if (!trimmed) {
      count += Math.max(1, Math.ceil(seg.length / 4));
    } else if (/[^\x00-\x7F]/.test(trimmed)) {
      count += Math.max(1, Math.ceil(Buffer.byteLength(seg, 'utf8') / 2.5));
    } else {
      count += 1;
    }
  }
  return count;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, countSegments(text));
}

export function countWords(text: string): number {
  const matches = text.match(/[^\s]+/g);
  return matches ? matches.length : 0;
}

/**
 * Incremental estimator: `push(delta)` returns how many normalized tokens that delta added, and
 * the running `total` always equals `estimateTokens(everything pushed so far)`, however the text
 * was split into chunks. A delta that only continues the previous word adds 0.
 */
export class StreamTokenCounter {
  private settled = 0;
  private tail = '';
  private tailTokens = 0;

  get total(): number {
    return this.settled + this.tailTokens;
  }

  push(delta: string): number {
    if (!delta) return 0;
    const before = this.total;
    this.tail += delta;

    // No segment of SEGMENT_RE spans a non-whitespace -> whitespace boundary, so everything before
    // the start of the last whitespace run can be counted once and dropped.
    const cut = this.lastWhitespaceRunStart(this.tail);
    if (cut > 0) {
      this.settled += countSegments(this.tail.slice(0, cut));
      this.tail = this.tail.slice(cut);
    }
    this.tailTokens = countSegments(this.tail);
    return this.total - before;
  }

  private lastWhitespaceRunStart(text: string): number {
    let i = text.length - 1;
    while (i >= 0 && !/\s/.test(text[i])) i--;
    if (i < 0) return -1;
    while (i > 0 && /\s/.test(text[i - 1])) i--;
    return i;
  }
}
