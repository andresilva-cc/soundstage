// Unit tests for ElevenLabsAdapter (src/adapters/elevenlabs/index.ts).
// All API calls mocked — no real network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deriveKey } from "../../src/adapters/cache/key.js";
import { SoundstageError } from "../../src/ir/errors.js";
import type { TtsAdapter, SynthRequest } from "../../src/adapters/types.js";

// ---------------------------------------------------------------------------
// Mock elevenlabs module (must be hoisted before imports)
// ---------------------------------------------------------------------------

// vi.hoisted ensures these values are available when the vi.mock factory runs.
const { mockConvert, MockElevenLabsClient } = vi.hoisted(() => {
  const mockConvert = vi.fn();
  const MockElevenLabsClient = vi.fn().mockImplementation(() => ({
    textToSpeech: { convert: mockConvert },
  }));
  return { mockConvert, MockElevenLabsClient };
});

vi.mock("elevenlabs", () => ({
  ElevenLabsClient: MockElevenLabsClient,
  ElevenLabsError: class ElevenLabsError extends Error {
    public statusCode: number | undefined;
    public body: unknown;
    constructor({
      message,
      statusCode,
    }: { message?: string; statusCode?: number } = {}) {
      super(message ?? "");
      this.name = "ElevenLabsError";
      this.statusCode = statusCode;
      this.body = undefined;
    }
  },
}));

// ---------------------------------------------------------------------------
// Import adapter AFTER vi.mock (hoisting guarantees mock is registered first)
// ---------------------------------------------------------------------------

import { ElevenLabsAdapter } from "../../src/adapters/elevenlabs/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(overrides: Partial<SynthRequest> = {}): SynthRequest {
  return {
    text: "hello world",
    voice: "21m00Tcm4TlvDq8ikWAM",
    sampleRate: 24000,
    ...overrides,
  };
}

/** Build a Buffer containing N int16 samples with a given value. */
function makeInt16Buffer(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i]!, i * 2);
  }
  return buf;
}

/** Minimal async-iterable that yields the given buffer (matches what collectStream needs). */
function makeStream(data: Buffer): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield data;
    },
  };
}

const ORIGINAL_API_KEY = process.env.ELEVENLABS_API_KEY;

beforeEach(() => {
  delete process.env.ELEVENLABS_API_KEY;
  vi.clearAllMocks();
  MockElevenLabsClient.mockImplementation(() => ({
    textToSpeech: { convert: mockConvert },
  }));
});

afterEach(() => {
  if (ORIGINAL_API_KEY !== undefined) {
    process.env.ELEVENLABS_API_KEY = ORIGINAL_API_KEY;
  } else {
    delete process.env.ELEVENLABS_API_KEY;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Lazy-import guard — source must NOT have a top-level static import of 'elevenlabs'
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — lazy import contract", () => {
  it("source file has no top-level static import of 'elevenlabs'", async () => {
    // Read the adapter source directly so a regression to `import { ElevenLabsClient }
    // from 'elevenlabs'` fails this test — even though vi.mock would mask the module-not-
    // found error, the contract (optional peer dep must not be eagerly loaded) would break
    // for users who have not installed elevenlabs.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const srcPath = fileURLToPath(
      new URL("../../src/adapters/elevenlabs/index.ts", import.meta.url),
    );
    const source = readFileSync(srcPath, "utf8");

    // Must NOT contain a top-level static import from 'elevenlabs'
    const staticImportRe = /^import\s+.*from\s+['"]elevenlabs['"]/m;
    expect(staticImportRe.test(source)).toBe(false);

    // Must NOT contain a top-level require of 'elevenlabs'
    const staticRequireRe = /^(?:const|let|var)\s+\S.*=\s*require\s*\(\s*['"]elevenlabs['"]\s*\)/m;
    expect(staticRequireRe.test(source)).toBe(false);

    // MUST contain a dynamic import('elevenlabs') inside a function body
    const dynamicImportRe = /\bimport\s*\(\s*["']elevenlabs["']\s*\)/;
    expect(dynamicImportRe.test(source)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Interface conformance
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — interface conformance", () => {
  it("satisfies TtsAdapter (runtime shape check)", () => {
    const adapter: TtsAdapter = new ElevenLabsAdapter({
      model: "eleven_multilingual_v2",
    });
    expect(typeof adapter.id).toBe("string");
    expect(typeof adapter.model).toBe("string");
    expect(typeof adapter.canonicalSettings).toBe("function");
    expect(typeof adapter.synth).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — identity", () => {
  it("id is 'elevenlabs'", () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    expect(adapter.id).toBe("elevenlabs");
  });

  it("model matches the constructor argument", () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_flash_v2_5" });
    expect(adapter.model).toBe("eleven_flash_v2_5");
  });

  it("different model strings are stored correctly", () => {
    const a = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    const b = new ElevenLabsAdapter({ model: "eleven_turbo_v2_5" });
    expect(a.model).toBe("eleven_multilingual_v2");
    expect(b.model).toBe("eleven_turbo_v2_5");
  });
});

// ---------------------------------------------------------------------------
// canonicalSettings — defaults
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — canonicalSettings defaults", () => {
  const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });

  it("returns all four defaults when no settings are specified", () => {
    const result = adapter.canonicalSettings(req());
    expect(result).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    });
  });

  it("stability defaults to 0.5", () => {
    expect(adapter.canonicalSettings(req()).stability).toBe(0.5);
  });

  it("similarity_boost defaults to 0.75", () => {
    expect(adapter.canonicalSettings(req()).similarity_boost).toBe(0.75);
  });

  it("style defaults to 0.0", () => {
    expect(adapter.canonicalSettings(req()).style).toBe(0.0);
  });

  it("use_speaker_boost defaults to true", () => {
    expect(adapter.canonicalSettings(req()).use_speaker_boost).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canonicalSettings — explicit overrides
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — canonicalSettings explicit values", () => {
  const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });

  it("returns explicit stability when provided", () => {
    // Cast to bypass SynthRequest type since these are ElevenLabs-specific extras
    const richReq = {
      ...req(),
      stability: 0.3,
    } as SynthRequest;
    expect(adapter.canonicalSettings(richReq).stability).toBe(0.3);
  });

  it("returns explicit similarity_boost when provided", () => {
    const richReq = { ...req(), similarity_boost: 0.9 } as SynthRequest;
    expect(adapter.canonicalSettings(richReq).similarity_boost).toBe(0.9);
  });

  it("returns explicit style when provided", () => {
    const richReq = { ...req(), style: 0.5 } as SynthRequest;
    expect(adapter.canonicalSettings(richReq).style).toBe(0.5);
  });

  it("returns explicit use_speaker_boost = false when provided", () => {
    const richReq = { ...req(), use_speaker_boost: false } as SynthRequest;
    expect(adapter.canonicalSettings(richReq).use_speaker_boost).toBe(false);
  });

  it("all four overridden at once", () => {
    const richReq = {
      ...req(),
      stability: 0.1,
      similarity_boost: 0.2,
      style: 0.3,
      use_speaker_boost: false,
    } as SynthRequest;
    expect(adapter.canonicalSettings(richReq)).toEqual({
      stability: 0.1,
      similarity_boost: 0.2,
      style: 0.3,
      use_speaker_boost: false,
    });
  });
});

// ---------------------------------------------------------------------------
// canonicalSettings — excluded fields
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — canonicalSettings excluded fields", () => {
  const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });

  it("does not include 'voice' in settings", () => {
    expect(adapter.canonicalSettings(req({ voice: "21m00Tcm4TlvDq8ikWAM" }))).not.toHaveProperty(
      "voice",
    );
  });

  it("does not include 'sampleRate' in settings", () => {
    expect(adapter.canonicalSettings(req({ sampleRate: 24000 }))).not.toHaveProperty("sampleRate");
  });

  it("does not include 'ELEVENLABS_API_KEY' in settings", () => {
    expect(adapter.canonicalSettings(req())).not.toHaveProperty("ELEVENLABS_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// synth() — missing API key
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — synth() missing API key", () => {
  it("throws SoundstageError E_ADAPTER_MISSING_KEY when ELEVENLABS_API_KEY is absent", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    await expect(adapter.synth(req())).rejects.toSatisfy((err: unknown) => {
      return err instanceof SoundstageError && err.code === "E_ADAPTER_MISSING_KEY";
    });
  });

  it("error message mentions ELEVENLABS_API_KEY", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    await expect(adapter.synth(req())).rejects.toSatisfy((err: unknown) => {
      return err instanceof Error && err.message.includes("ELEVENLABS_API_KEY");
    });
  });
});

// ---------------------------------------------------------------------------
// synth() — int16 → Float32 conversion
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — int16 → Float32 conversion", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "test-key";
  });

  it("int16 value 16384 converts to Float32 ≈ 0.5", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    const buf = makeInt16Buffer([16384]);
    mockConvert.mockResolvedValueOnce(makeStream(buf));

    const result = await adapter.synth(req());
    expect(result.pcm[0]).toBeCloseTo(0.5, 4);
  });

  it("int16 value -32768 converts to Float32 = -1.0", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    const buf = makeInt16Buffer([-32768]);
    mockConvert.mockResolvedValueOnce(makeStream(buf));

    const result = await adapter.synth(req());
    expect(result.pcm[0]).toBeCloseTo(-1.0, 4);
  });

  it("int16 value 0 converts to 0.0", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    const buf = makeInt16Buffer([0]);
    mockConvert.mockResolvedValueOnce(makeStream(buf));

    const result = await adapter.synth(req());
    expect(result.pcm[0]).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// synth() — SynthResult fields
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — synth() result fields", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "test-key";
  });

  it("returns sampleRate 24000", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    const buf = makeInt16Buffer([100, 200, 300, 400]);
    mockConvert.mockResolvedValueOnce(makeStream(buf));

    const result = await adapter.synth(req());
    expect(result.sampleRate).toBe(24000);
  });

  it("durationSamples equals pcm.length", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    const buf = makeInt16Buffer(Array(40).fill(1000));
    mockConvert.mockResolvedValueOnce(makeStream(buf));

    const result = await adapter.synth(req());
    expect(result.durationSamples).toBe(result.pcm.length);
  });
});

// ---------------------------------------------------------------------------
// synth() — internal chunking (text > 2400 chars)
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — internal chunking", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    vi.useFakeTimers(); // skip retry backoff delays
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes exactly 1 API call when text is within 2400 chars", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    const buf = makeInt16Buffer([100, 200]);
    mockConvert.mockResolvedValueOnce(makeStream(buf));

    await adapter.synth(req({ text: "Short text." }));
    expect(mockConvert).toHaveBeenCalledTimes(1);
  });

  it("does NOT split at exactly 2400 chars (boundary: <= does not split)", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    // Exactly 2400 chars with a sentence boundary in the middle
    // "A".repeat(1199) + ". " + "B".repeat(1199) + "." = 1199+2+1199+1 = 2401? No.
    // "A".repeat(1199) + ". " + "B".repeat(1198) + "." = 1199+2+1198+1 = 2400 chars exactly
    const exactText = "A".repeat(1199) + ". " + "B".repeat(1198) + ".";
    expect(exactText.length).toBe(2400);

    const buf = makeInt16Buffer([1, 2, 3]);
    mockConvert.mockResolvedValueOnce(makeStream(buf));

    await adapter.synth(req({ text: exactText }));
    // At exactly the limit, no split — exactly 1 call
    expect(mockConvert).toHaveBeenCalledTimes(1);
  });

  it("DOES split at 2401 chars (boundary: > limit triggers split)", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    // 2401 chars with a sentence boundary in the middle
    // "A".repeat(1199) + ". " + "B".repeat(1199) + "." = 1199+2+1199+1 = 2401 chars exactly
    const overText = "A".repeat(1199) + ". " + "B".repeat(1199) + ".";
    expect(overText.length).toBe(2401);

    const buf1 = makeInt16Buffer([1]);
    const buf2 = makeInt16Buffer([2]);
    mockConvert
      .mockResolvedValueOnce(makeStream(buf1))
      .mockResolvedValueOnce(makeStream(buf2));

    await adapter.synth(req({ text: overText }));
    // Over the limit with a sentence boundary → splits into 2 calls
    expect(mockConvert).toHaveBeenCalledTimes(2);
  });

  it("makes multiple API calls when text exceeds 2400 chars", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });

    // Build text with 3 sentences of ~900 chars each = ~2700 chars total
    const sentence1 = "A".repeat(800) + ".";
    const sentence2 = "B".repeat(800) + ".";
    const sentence3 = "C".repeat(800) + ".";
    const longText = `${sentence1} ${sentence2} ${sentence3}`;
    // longText.length = 801 + 1 + 801 + 1 + 801 = 2405 > 2400

    const buf1 = makeInt16Buffer([100, 200, 300]); // 3 samples
    const buf2 = makeInt16Buffer([400, 500]); // 2 samples
    mockConvert
      .mockResolvedValueOnce(makeStream(buf1))
      .mockResolvedValueOnce(makeStream(buf2));

    const result = await adapter.synth(req({ text: longText }));

    expect(mockConvert.mock.calls.length).toBeGreaterThan(1);
    // Combined PCM length = 3 + 2 = 5 samples
    expect(result.durationSamples).toBe(5);
    expect(result.pcm).toHaveLength(5);
  });

  it("combined PCM length equals sum of per-call lengths", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });

    const sentence1 = "A".repeat(900) + ".";
    const sentence2 = "B".repeat(900) + ".";
    const sentence3 = "C".repeat(900) + ".";
    const longText = `${sentence1} ${sentence2} ${sentence3}`;

    const samples1 = Array(10).fill(1000);
    const samples2 = Array(8).fill(2000);
    mockConvert
      .mockResolvedValueOnce(makeStream(makeInt16Buffer(samples1)))
      .mockResolvedValueOnce(makeStream(makeInt16Buffer(samples2)));

    const result = await adapter.synth(req({ text: longText }));

    const callCount = mockConvert.mock.calls.length;
    expect(callCount).toBeGreaterThan(1);
    // Sum of per-call lengths = 10 + 8 = 18 (or whatever split gives us)
    expect(result.pcm.length).toBe(10 + 8);
  });

  it("sequential per-chunk calls: second chunk's PCM follows first in combined output", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });

    const sentence1 = "A".repeat(900) + ".";
    const sentence2 = "B".repeat(900) + ".";
    const sentence3 = "C".repeat(900) + ".";
    const longText = `${sentence1} ${sentence2} ${sentence3}`;

    // First call: single sample with value 16384 → Float32 ≈ 0.5
    const buf1 = makeInt16Buffer([16384]);
    // Second call: single sample with value -16384 → Float32 ≈ -0.5
    const buf2 = makeInt16Buffer([-16384]);
    mockConvert
      .mockResolvedValueOnce(makeStream(buf1))
      .mockResolvedValueOnce(makeStream(buf2));

    const result = await adapter.synth(req({ text: longText }));

    expect(result.pcm.length).toBe(2);
    expect(result.pcm[0]).toBeCloseTo(0.5, 4);
    expect(result.pcm[1]).toBeCloseTo(-0.5, 4);
  });
});

// ---------------------------------------------------------------------------
// synth() — multi-chunk error path (later chunk fails)
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — multi-chunk: later chunk failure → E_ADAPTER_REQUEST_FAILED", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "multi-chunk-key";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces E_ADAPTER_REQUEST_FAILED when the second chunk's call fails terminally", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });

    // Build text that splits into exactly 2 chunks (both > 2400 chars total)
    const sentence1 = "A".repeat(900) + ".";
    const sentence2 = "B".repeat(900) + ".";
    const sentence3 = "C".repeat(900) + ".";
    const longText = `${sentence1} ${sentence2} ${sentence3}`;

    // First chunk succeeds, second fails terminally
    const goodBuf = makeInt16Buffer([100, 200]);
    mockConvert
      .mockResolvedValueOnce(makeStream(goodBuf))
      .mockRejectedValue(new Error("connection reset on chunk 2"));

    const promise = adapter.synth(req({ text: longText }));
    const suppressed = promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await suppressed;

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return err instanceof SoundstageError && err.code === "E_ADAPTER_REQUEST_FAILED";
    });
  });

  it("error message for later-chunk failure does not include the API key", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });

    const sentence1 = "A".repeat(900) + ".";
    const sentence2 = "B".repeat(900) + ".";
    const sentence3 = "C".repeat(900) + ".";
    const longText = `${sentence1} ${sentence2} ${sentence3}`;

    const goodBuf = makeInt16Buffer([100]);
    mockConvert
      .mockResolvedValueOnce(makeStream(goodBuf))
      .mockRejectedValue(new Error("upstream error"));

    const promise = adapter.synth(req({ text: longText }));
    const suppressed = promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await suppressed;

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return err instanceof Error && !err.message.includes("multi-chunk-key");
    });
  });
});

// ---------------------------------------------------------------------------
// Cache key transparency — full text is always the cache key
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — cache key transparency", () => {
  it("deriveKey produces the same key regardless of how many internal chunks are needed", () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });

    const shortText = "Hello world.";
    const longText =
      "A".repeat(900) + ". " + "B".repeat(900) + ". " + "C".repeat(900) + ".";

    const shortKey = deriveKey(req({ text: shortText }), adapter);
    const shortKey2 = deriveKey(req({ text: shortText }), adapter);
    const longKey = deriveKey(req({ text: longText }), adapter);
    const longKey2 = deriveKey(req({ text: longText }), adapter);

    // Same text → same key (deterministic)
    expect(shortKey).toBe(shortKey2);
    expect(longKey).toBe(longKey2);

    // Different text → different key
    expect(shortKey).not.toBe(longKey);
  });

  it("cache key uses full text (not chunks) — two calls with same text produce same key", () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    const text = "A".repeat(900) + ". " + "B".repeat(900) + ". " + "C".repeat(900) + ".";

    const key1 = deriveKey(req({ text }), adapter);
    const key2 = deriveKey(req({ text }), adapter);
    expect(key1).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// synth() — terminal failure → E_ADAPTER_REQUEST_FAILED
// ---------------------------------------------------------------------------

describe("ElevenLabsAdapter — terminal request failure → E_ADAPTER_REQUEST_FAILED", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("SDK error with 429 statusCode eventually throws E_ADAPTER_REQUEST_FAILED", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });

    // Mock a 429-like error object (duck-typed, not necessarily instanceof ElevenLabsError)
    const sdk429 = Object.assign(new Error("rate limited"), { statusCode: 429 });
    mockConvert.mockRejectedValue(sdk429);

    const promise = adapter.synth(req());
    const suppressed = promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await suppressed;

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return err instanceof SoundstageError && err.code === "E_ADAPTER_REQUEST_FAILED";
    });
  });

  it("generic Error throws E_ADAPTER_REQUEST_FAILED", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    mockConvert.mockRejectedValue(new Error("connection refused"));

    const promise = adapter.synth(req());
    await promise.catch(() => undefined);

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return err instanceof SoundstageError && err.code === "E_ADAPTER_REQUEST_FAILED";
    });
  });

  it("error message does not include the API key", async () => {
    process.env.ELEVENLABS_API_KEY = "super-secret-key";
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    mockConvert.mockRejectedValue(new Error("something failed"));

    const promise = adapter.synth(req());
    await promise.catch(() => undefined);

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return err instanceof Error && !err.message.includes("super-secret-key");
    });
  });
});
