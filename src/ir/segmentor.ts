// Sentence-level text segmentor — pure, deterministic.
// §T7: segment(text) → string[] splits a Voice text into cache-granular chunks.
// Each chunk becomes a separate cache entry, enabling per-sentence incremental re-render.

/** Minimum chunk length in characters. Short trailing fragments below this threshold
 *  are merged into the preceding chunk (when the preceding is long enough). */
const MIN_CHUNK_LENGTH = 40;

/** Maximum chunk length in characters. Chunks exceeding this are force-split at
 *  word boundaries. Changing this constant requires a schema version bump (v5+). */
const MAX_CHUNK_LENGTH = 500;

/**
 * Split text into sentence-granular chunks for cache key derivation.
 *
 * Algorithm:
 * 1. Normalize CRLF → LF (so identical text with different line endings gives the same chunks).
 * 2. Split at sentence-ending punctuation (., !, ?) followed by whitespace or end-of-string.
 *    Trailing punctuation stays with its sentence ("Hello world." → "Hello world.").
 * 3. Force-split chunks exceeding MAX_CHUNK_LENGTH=500 at word boundaries.
 * 4. Merge each short chunk (< MIN_CHUNK_LENGTH=40 chars) into its preceding chunk,
 *    but ONLY when the preceding chunk is already ≥ MIN_CHUNK_LENGTH (avoids merging
 *    two short sentences that should stay independent).
 *
 * Guarantees:
 * - Always returns at least one non-empty string.
 * - Pure: same input → same output.
 * - All returned chunks are non-empty strings with length ≤ MAX_CHUNK_LENGTH.
 */
export function segment(text: string): string[] {
  // 1. Normalize line endings.
  const normalized = text.replace(/\r\n/g, "\n");

  // 2. Split at sentence boundaries: ., !, ? followed by whitespace or EOS.
  //    Lookahead ensures the punctuation stays with the sentence.
  const raw: string[] = [];
  let lastEnd = 0;

  for (const match of normalized.matchAll(/[.?!](?=\s|$)/g)) {
    const endPos = (match.index as number) + 1; // include the punctuation char
    const chunk = normalized.slice(lastEnd, endPos).trim();
    if (chunk.length > 0) raw.push(chunk);
    lastEnd = endPos;
    // Skip any following whitespace before the next sentence.
    while (lastEnd < normalized.length && /\s/.test(normalized[lastEnd]!)) {
      lastEnd++;
    }
  }

  // Trailing text that has no ending punctuation (or the whole text if no boundaries found).
  if (lastEnd < normalized.length) {
    const trailing = normalized.slice(lastEnd).trim();
    if (trailing.length > 0) raw.push(trailing);
  }

  // If nothing was split (empty input or all whitespace), return the original.
  const base = raw.length > 0 ? raw : [normalized.trim() || text];

  // 3. Force-split any chunk exceeding MAX_CHUNK_LENGTH at a word boundary.
  const split: string[] = [];
  for (const chunk of base) {
    if (chunk.length <= MAX_CHUNK_LENGTH) {
      split.push(chunk);
    } else {
      let remaining = chunk;
      while (remaining.length > MAX_CHUNK_LENGTH) {
        let at = remaining.lastIndexOf(" ", MAX_CHUNK_LENGTH);
        if (at <= 0) at = MAX_CHUNK_LENGTH; // no space found — hard cut
        split.push(remaining.slice(0, at).trim());
        remaining = remaining.slice(at).trim();
      }
      if (remaining.length > 0) split.push(remaining);
    }
  }

  // 4. Merge short trailing chunks into their preceding chunk when the preceding
  //    is long enough (≥ MIN_CHUNK_LENGTH). This avoids tiny cache entries for
  //    phrases like "Ok." after a long sentence.
  const result: string[] = [];
  for (const chunk of split) {
    const prev = result[result.length - 1];
    if (
      chunk.length < MIN_CHUNK_LENGTH &&
      prev !== undefined &&
      prev.length >= MIN_CHUNK_LENGTH &&
      prev.length + 1 + chunk.length <= MAX_CHUNK_LENGTH
    ) {
      result[result.length - 1] = prev + " " + chunk;
    } else {
      result.push(chunk);
    }
  }

  // Final safety: filter out any empty or whitespace-only strings, then fall back
  // to the original text if nothing remains (e.g. for empty/whitespace-only input).
  const safe = result.filter(s => s.trim().length > 0);
  return safe.length > 0 ? safe : [text || " "];
}
