// Unit tests for OpenAiAdapter (src/adapters/openai/index.ts).
// No real API calls — fetch is mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAiAdapter } from "../../src/adapters/openai/index.js";
import type { TtsAdapter, SynthRequest } from "../../src/adapters/types.js";
import { SoundstageError } from "../../src/ir/errors.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal SynthRequest
// ---------------------------------------------------------------------------

function req(overrides: Partial<SynthRequest> = {}): SynthRequest {
  return {
    text: "hello world",
    voice: "alloy",
    sampleRate: 24000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Store original fetch and OPENAI_API_KEY
// ---------------------------------------------------------------------------

const ORIGINAL_API_KEY = process.env.OPENAI_API_KEY;

beforeEach(() => {
  // Clear the API key by default; individual tests set it as needed.
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  // Restore original key.
  if (ORIGINAL_API_KEY !== undefined) {
    process.env.OPENAI_API_KEY = ORIGINAL_API_KEY;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
  vi.unstubAllGlobals(); // clean up any vi.stubGlobal("fetch", ...) calls
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Interface conformance: TypeScript enforces this at compile time.
// The test below confirms the runtime shape as well.
// ---------------------------------------------------------------------------

describe("OpenAiAdapter — interface conformance", () => {
  it("satisfies TtsAdapter (runtime shape check)", () => {
    const adapter: TtsAdapter = new OpenAiAdapter();
    expect(typeof adapter.id).toBe("string");
    expect(typeof adapter.model).toBe("string");
    expect(typeof adapter.canonicalSettings).toBe("function");
    expect(typeof adapter.synth).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("OpenAiAdapter — identity", () => {
  it("id is 'openai'", () => {
    const adapter = new OpenAiAdapter();
    expect(adapter.id).toBe("openai");
  });

  it("model defaults to 'tts-1'", () => {
    const adapter = new OpenAiAdapter();
    expect(adapter.model).toBe("tts-1");
  });

  it("model is 'tts-1-hd' when specified in constructor", () => {
    const adapter = new OpenAiAdapter({ model: "tts-1-hd" });
    expect(adapter.model).toBe("tts-1-hd");
  });
});

// ---------------------------------------------------------------------------
// canonicalSettings
// ---------------------------------------------------------------------------

describe("OpenAiAdapter — canonicalSettings", () => {
  const adapter = new OpenAiAdapter();

  it("returns { speed: 1.0 } when speed is 1.0", () => {
    expect(adapter.canonicalSettings(req({ speed: 1.0 }))).toEqual({ speed: 1.0 });
  });

  it("returns { speed: 1.0 } when speed is omitted (undefined)", () => {
    // SynthRequest.speed is optional — omit it entirely (exactOptionalPropertyTypes).
    const noSpeed: SynthRequest = { text: "hello world", voice: "alloy", sampleRate: 24000 };
    expect(adapter.canonicalSettings(noSpeed)).toEqual({ speed: 1.0 });
  });

  it("undefined and explicit 1.0 produce identical settings", () => {
    const noSpeed: SynthRequest = { text: "hello world", voice: "alloy", sampleRate: 24000 };
    expect(adapter.canonicalSettings(noSpeed)).toEqual(
      adapter.canonicalSettings(req({ speed: 1.0 })),
    );
  });

  it("does not include 'voice' in settings", () => {
    expect(adapter.canonicalSettings(req({ voice: "alloy" }))).not.toHaveProperty("voice");
  });

  it("does not include 'sampleRate' in settings", () => {
    expect(adapter.canonicalSettings(req({ sampleRate: 24000 }))).not.toHaveProperty("sampleRate");
  });

  it("returns the explicit speed when not 1.0", () => {
    expect(adapter.canonicalSettings(req({ speed: 1.5 }))).toEqual({ speed: 1.5 });
  });
});

// ---------------------------------------------------------------------------
// synth() — missing key error
// ---------------------------------------------------------------------------

describe("OpenAiAdapter — synth() — missing API key", () => {
  it("throws SoundstageError E_ADAPTER_MISSING_KEY when OPENAI_API_KEY is absent", async () => {
    const adapter = new OpenAiAdapter();
    // OPENAI_API_KEY is unset (cleared in beforeEach).
    await expect(adapter.synth(req())).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof SoundstageError &&
        err.code === "E_ADAPTER_MISSING_KEY"
      );
    });
  });

  it("error message mentions OPENAI_API_KEY", async () => {
    const adapter = new OpenAiAdapter();
    await expect(adapter.synth(req())).rejects.toSatisfy((err: unknown) => {
      return err instanceof Error && err.message.includes("OPENAI_API_KEY");
    });
  });
});

// ---------------------------------------------------------------------------
// synth() — int16 → Float32 conversion
// ---------------------------------------------------------------------------

describe("OpenAiAdapter — int16 → Float32 conversion", () => {
  function makeInt16PcmBuffer(samples: number[]): ArrayBuffer {
    const buf = new ArrayBuffer(samples.length * 2);
    const view = new Int16Array(buf);
    for (let i = 0; i < samples.length; i++) {
      view[i] = samples[i]!;
    }
    return buf;
  }

  async function synthWithFakePcm(samples: number[]): Promise<Float32Array> {
    process.env.OPENAI_API_KEY = "sk-test";
    const buf = makeInt16PcmBuffer(samples);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(buf),
    } as unknown as Response));

    const adapter = new OpenAiAdapter();
    const result = await adapter.synth(req());
    return result.pcm;
  }

  it("int16 value 16384 converts to Float32 ≈ 0.5", async () => {
    const pcm = await synthWithFakePcm([16384]);
    expect(pcm[0]).toBeCloseTo(0.5, 4);
  });

  it("int16 value 32767 converts to Float32 ≈ 1.0 (just below)", async () => {
    const pcm = await synthWithFakePcm([32767]);
    expect(pcm[0]).toBeGreaterThan(0.99);
    expect(pcm[0]).toBeLessThanOrEqual(1.0);
  });

  it("int16 value -32768 converts to Float32 = -1.0", async () => {
    const pcm = await synthWithFakePcm([-32768]);
    expect(pcm[0]).toBeCloseTo(-1.0, 4);
  });

  it("int16 value 0 converts to Float32 = 0.0", async () => {
    const pcm = await synthWithFakePcm([0]);
    expect(pcm[0]).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// synth() — SynthResult fields
// ---------------------------------------------------------------------------

describe("OpenAiAdapter — synth() result", () => {
  it("returns sampleRate 24000 and durationSamples > 0", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    const fakeSamples = [100, 200, 300, 400]; // 4 int16 samples
    const buf = new ArrayBuffer(fakeSamples.length * 2);
    const view = new Int16Array(buf);
    fakeSamples.forEach((v, i) => (view[i] = v));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(buf),
    } as unknown as Response));

    const adapter = new OpenAiAdapter();
    const result = await adapter.synth(req());

    expect(result.sampleRate).toBe(24000);
    expect(result.durationSamples).toBe(4);
    expect(result.pcm).toHaveLength(4);
  });

  it("durationSamples equals pcm.length", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    const numSamples = 120;
    const buf = new ArrayBuffer(numSamples * 2);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(buf),
    } as unknown as Response));

    const adapter = new OpenAiAdapter();
    const result = await adapter.synth(req());
    expect(result.durationSamples).toBe(result.pcm.length);
  });
});

// ---------------------------------------------------------------------------
// synth() — terminal API failures → SoundstageError(E_ADAPTER_REQUEST_FAILED)
// These tests use fake timers to skip retry backoff delays.
// ---------------------------------------------------------------------------

describe("OpenAiAdapter — terminal request failures → E_ADAPTER_REQUEST_FAILED", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("HttpResponseError (429 exhausted) → SoundstageError(E_ADAPTER_REQUEST_FAILED)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    } as unknown as Response));

    const adapter = new OpenAiAdapter();
    const promise = adapter.synth(req());
    const suppressed = promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await suppressed;

    await expect(promise).rejects.toSatisfy((err: unknown) =>
      err instanceof SoundstageError && err.code === "E_ADAPTER_REQUEST_FAILED",
    );
  });

  it("network TypeError (fetch failed) → SoundstageError(E_ADAPTER_REQUEST_FAILED)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const adapter = new OpenAiAdapter();
    const promise = adapter.synth(req());
    const suppressed = promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await suppressed;

    await expect(promise).rejects.toSatisfy((err: unknown) =>
      err instanceof SoundstageError && err.code === "E_ADAPTER_REQUEST_FAILED",
    );
  });

  it("error message does not include the API key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as unknown as Response));

    const adapter = new OpenAiAdapter();
    const promise = adapter.synth(req());
    const suppressed = promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await suppressed;

    await expect(promise).rejects.toSatisfy((err: unknown) =>
      err instanceof Error && !err.message.includes("sk-test"),
    );
  });
});
