const BPE_SEGMENT_RE =
  /'(?:s|t|re|ve|m|ll|d)| ?[A-Za-z]+| ?[0-9]{1,3}| ?[^\sA-Za-z0-9\x00-\x7F]+| ?[^\sA-Za-z0-9]+|\s+/gi;

export function estimateTokens(text: string): number {
  if (!text) return 0;

  let count = 0;
  const matches = text.match(BPE_SEGMENT_RE);
  if (!matches) {
    return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3.5));
  }

  for (const seg of matches) {
    const trimmed = seg.trim();
    if (!trimmed) {
      // Pure whitespace / newlines usually pack 1 token per ~4 chars or newline
      count += Math.max(1, Math.ceil(seg.length / 4));
      continue;
    }

    // Check if segment contains non-ASCII characters (CJK, emoji, etc.)
    if (/[^\x00-\x7F]/.test(trimmed)) {
      count += Math.max(1, Math.ceil(Buffer.byteLength(seg, 'utf8') / 2.5));
      continue;
    }

    // Long ASCII letter runs split into subwords (~4.2 chars per BPE token)
    if (/^[A-Za-z]+$/.test(trimmed) && trimmed.length > 6) {
      count += Math.ceil(trimmed.length / 4.2);
      continue;
    }

    count += 1;
  }

  return Math.max(1, count);
}
