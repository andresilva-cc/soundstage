// Unit tests for src/ir/segmentor.ts — adversarial + determinism + merge/cap rules.

import { describe, it, expect } from "vitest";
import { segment } from "../../src/ir/segmentor.js";

// ---------------------------------------------------------------------------
// Basic splitting — AC1/AC2
// ---------------------------------------------------------------------------

describe("basic splitting", () => {
  it("two sentences split at period+space", () => {
    expect(segment("Hello world. Goodbye.")).toEqual(["Hello world.", "Goodbye."]);
  });

  it("no sentence boundary → single chunk", () => {
    expect(segment("Short text")).toEqual(["Short text"]);
  });

  it("splits on question mark", () => {
    // Both chunks ≥ 40 chars so no merge fires (merge only when trailing chunk < 40)
    const text = "Is this the first question with enough chars here? And the answer is definitely yes, no question about it.";
    const chunks = segment(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatch(/\?$/);
  });

  it("splits on exclamation mark", () => {
    // Both chunks ≥ 40 chars so no merge
    const text = "This is quite an exciting first sentence with many chars! And here comes the second sentence with enough characters.";
    const chunks = segment(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatch(/!$/);
  });

  it("trailing punctuation stays with its sentence", () => {
    const chunks = segment("Hello world. Goodbye.");
    expect(chunks[0]).toBe("Hello world.");
    expect(chunks[1]).toBe("Goodbye.");
  });
});

// ---------------------------------------------------------------------------
// Determinism — AC3
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("two calls with same input produce identical results", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    expect(segment(text)).toEqual(segment(text));
  });

  it("complex input is deterministic", () => {
    const text = "A sentence that is certainly long enough to qualify. Another one here with some words. And a final one.";
    const first = segment(text);
    const second = segment(text);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// CRLF normalization — AC4
// ---------------------------------------------------------------------------

describe("CRLF normalization", () => {
  it("CRLF produces same chunks as LF", () => {
    const lf = "Hello world.\nGoodbye.";
    const crlf = "Hello world.\r\nGoodbye.";
    expect(segment(crlf)).toEqual(segment(lf));
  });

  it("mixed CRLF/LF normalizes consistently", () => {
    const mixed = "First sentence.\r\nSecond sentence.\nThird sentence.";
    const lf = "First sentence.\nSecond sentence.\nThird sentence.";
    expect(segment(mixed)).toEqual(segment(lf));
  });
});

// ---------------------------------------------------------------------------
// MIN_CHUNK_LENGTH merge — AC5
// A short trailing chunk (< 40 chars) is merged into the preceding
// only when the preceding is ≥ 40 chars.
// ---------------------------------------------------------------------------

describe("MIN_CHUNK_LENGTH merge rule", () => {
  it("short trailing chunk merged into long preceding chunk", () => {
    // Preceding: "A sentence that is certainly long enough to qualify." = 51 chars >= 40
    // Trailing: "Ok." = 3 chars < 40
    const text = "A sentence that is certainly long enough to qualify. Ok.";
    const chunks = segment(text);
    // "Ok." gets merged into the preceding long sentence
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Ok.");
  });

  it("short chunk NOT merged when preceding is also short", () => {
    // Both "Hello world." (12 chars) and "Goodbye." (8 chars) are < 40
    // No merge since preceding is not >= MIN_CHUNK_LENGTH
    expect(segment("Hello world. Goodbye.")).toEqual(["Hello world.", "Goodbye."]);
  });

  it("short mid-chunk merged into preceding when preceding is long enough", () => {
    // Three sentences: long, short, long
    // "This is a long first sentence here with plenty of words." (57 chars >= 40)
    // "Oh." (3 chars < 40) → should merge into preceding
    // "And here is yet another long third sentence with many words." (60 chars >= 40)
    const text = "This is a long first sentence here with plenty of words. Oh. And here is yet another long third sentence with many words.";
    const chunks = segment(text);
    // "Oh." should be merged into the first long chunk
    // Result: ["This is a long first sentence here with plenty of words. Oh.", "And here is yet another long third sentence with many words."]
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("Oh.");
  });
});

// ---------------------------------------------------------------------------
// MAX_CHUNK_LENGTH splitting — AC6
// ---------------------------------------------------------------------------

describe("MAX_CHUNK_LENGTH cap", () => {
  it("text longer than MAX_CHUNK_LENGTH is split into multiple chunks", () => {
    // Single run of text with no sentence boundary, 600 chars > MAX_CHUNK_LENGTH=500
    const text = "A".repeat(200) + " " + "B".repeat(200) + " " + "C".repeat(200);
    // 601 chars with two spaces → exceeds 500
    const chunks = segment(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });

  it("each chunk is at most MAX_CHUNK_LENGTH chars", () => {
    // Generate a very long text with sentence boundaries that would create chunks > 500
    const longSentence = "word ".repeat(110).trim() + "."; // ~550 chars
    const text = longSentence + " " + longSentence;
    const chunks = segment(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });
});

// ---------------------------------------------------------------------------
// Never returns empty array — AC7 (property test over multiple inputs)
// ---------------------------------------------------------------------------

describe("never returns empty array", () => {
  const cases = [
    "Hello.",
    "Short text",
    "",
    " ",
    ".",
    "!",
    "?",
    "A".repeat(600),
    "Hello world. Goodbye.",
    "First sentence. Second sentence. Third sentence.",
  ];

  for (const text of cases) {
    it(`segment(${JSON.stringify(text.slice(0, 30))}) returns at least one chunk`, () => {
      const result = segment(text);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  }

  it("all returned chunks are non-empty strings", () => {
    const texts = cases.concat(["X".repeat(1000), "a. b. c. d. e."]);
    for (const text of texts) {
      const chunks = segment(text);
      for (const chunk of chunks) {
        expect(typeof chunk).toBe("string");
        expect(chunk.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Single-sentence behavior
// ---------------------------------------------------------------------------

describe("single-sentence Voice", () => {
  it("text ending with period but no mid-text boundary → 1 chunk", () => {
    expect(segment("Hello world.")).toEqual(["Hello world."]);
  });

  it("text with no punctuation → 1 chunk", () => {
    expect(segment("Hello world")).toEqual(["Hello world"]);
  });
});

// ---------------------------------------------------------------------------
// Three-sentence segmentation (used by seam golden test)
// ---------------------------------------------------------------------------

describe("three-sentence segmentation", () => {
  it("3 distinct sentences (each >= 40 chars) → 3 chunks", () => {
    const text = [
      "This is the first sentence which has enough characters to qualify.",
      "And here is the second sentence also with sufficient length.",
      "The third sentence completes this multi-chunk voice example.",
    ].join(" ");
    const chunks = segment(text);
    expect(chunks).toHaveLength(3);
  });
});
