import { describe, it, expect } from "vitest";
import type { TtsAdapter, SynthRequest, SynthResult } from "../src/adapters/types.ts";
import { SyntheticAdapter } from "../src/adapters/synthetic/index.ts";

// Helper: default request
function req(overrides: Partial<SynthRequest> = {}): SynthRequest {
  return { text: "hello", voice: "host", sampleRate: 24000, ...overrides };
}

// AC6 — id is "synthetic", model is a stable string identifier (S2: pin exact value)
describe("SyntheticAdapter — id and model", () => {
  const adapter = new SyntheticAdapter();

  it('id is "synthetic"', () => {
    expect(adapter.id).toBe("synthetic");
  });

  it('model is "synthetic-v1"', () => {
    expect(adapter.model).toBe("synthetic-v1");
  });
});

// AC1 — SyntheticAdapter satisfies TtsAdapter — TypeScript enforces at compile time.
// We additionally confirm at runtime that the shape matches.
describe("SyntheticAdapter — interface conformance", () => {
  it("satisfies TtsAdapter shape (no cast required)", () => {
    const adapter: TtsAdapter = new SyntheticAdapter();
    expect(typeof adapter.id).toBe("string");
    expect(typeof adapter.model).toBe("string");
    expect(typeof adapter.canonicalSettings).toBe("function");
    expect(typeof adapter.synth).toBe("function");
  });
});

// AC2 — synth returns non-zero pcm, sampleRate:24000, durationSamples===pcm.length
describe("SyntheticAdapter — synth basic result", () => {
  const adapter = new SyntheticAdapter();

  it('synth({ text: "hello" }) returns SynthResult with sampleRate 24000', async () => {
    const result: SynthResult = await adapter.synth(req({ text: "hello" }));
    expect(result.sampleRate).toBe(24000);
  });

  it("pcm is a non-zero Float32Array", async () => {
    const result = await adapter.synth(req({ text: "hello" }));
    expect(result.pcm).toBeInstanceOf(Float32Array);
    expect(result.pcm.length).toBeGreaterThan(0);
  });

  it("durationSamples === pcm.length", async () => {
    const result = await adapter.synth(req({ text: "hello" }));
    expect(result.durationSamples).toBe(result.pcm.length);
  });
});

// AC3 — same input → identical PCM (determinism)
describe("SyntheticAdapter — determinism", () => {
  const adapter = new SyntheticAdapter();

  it("two calls with same text return identical pcm", async () => {
    const r1 = await adapter.synth(req({ text: "determinism test" }));
    const r2 = await adapter.synth(req({ text: "determinism test" }));
    expect(r1.pcm).toEqual(r2.pcm);
  });

  it("same voice + text + speed produces identical pcm across adapter instances", async () => {
    const a1 = new SyntheticAdapter();
    const a2 = new SyntheticAdapter();
    const r1 = await a1.synth(req({ text: "same across instances", voice: "host", speed: 1.0 }));
    const r2 = await a2.synth(req({ text: "same across instances", voice: "host", speed: 1.0 }));
    expect(r1.pcm).toEqual(r2.pcm);
  });
});

// AC4 — different text → different PCM; also covers empty-string text (W2) and voice divergence (S1)
describe("SyntheticAdapter — different input yields different PCM", () => {
  const adapter = new SyntheticAdapter();

  it("different text → different pcm", async () => {
    const r1 = await adapter.synth(req({ text: "hello world" }));
    const r2 = await adapter.synth(req({ text: "goodbye world" }));
    expect(r1.pcm).not.toEqual(r2.pcm);
  });

  it("empty-string text produces a valid, non-zero SynthResult", async () => {
    const result = await adapter.synth(req({ text: "" }));
    expect(result.pcm).toBeInstanceOf(Float32Array);
    expect(result.pcm.length).toBeGreaterThan(0);
    expect(result.durationSamples).toBe(result.pcm.length);
    expect(result.sampleRate).toBe(24000);
  });

  it("empty-string text is deterministic", async () => {
    const r1 = await adapter.synth(req({ text: "" }));
    const r2 = await adapter.synth(req({ text: "" }));
    expect(r1.pcm).toEqual(r2.pcm);
  });

  it("different voice → different pcm (same text + speed)", async () => {
    const r1 = await adapter.synth(req({ text: "same text", voice: "host" }));
    const r2 = await adapter.synth(req({ text: "same text", voice: "guest" }));
    expect(r1.pcm).not.toEqual(r2.pcm);
  });
});

// AC5 — canonicalSettings returns exactly { speed } — voice is a top-level cache key field (§4.5).
// Speed defaults to 1.0 so undefined and explicit 1.0 produce the same cache key (W1 arch fix).
describe("SyntheticAdapter — canonicalSettings", () => {
  const adapter = new SyntheticAdapter();

  it("returns exactly { speed: 1.0 } when speed is not set (no voice — top-level field)", () => {
    const settings = adapter.canonicalSettings(req({ voice: "host" }));
    expect(settings).toEqual({ speed: 1.0 });
  });

  it("returns exactly { speed } when speed is set explicitly", () => {
    const settings = adapter.canonicalSettings(req({ voice: "host", speed: 1.5 }));
    expect(settings).toEqual({ speed: 1.5 });
  });

  it("undefined speed and explicit 1.0 produce the same settings (no cache-key divergence)", () => {
    const implicit = adapter.canonicalSettings(req({ voice: "host" }));
    const explicit = adapter.canonicalSettings(req({ voice: "host", speed: 1.0 }));
    expect(implicit).toEqual(explicit);
  });
});

// Speed affects output deterministically
describe("SyntheticAdapter — speed affects output", () => {
  const adapter = new SyntheticAdapter();

  it("different speed → different pcm", async () => {
    const r1 = await adapter.synth(req({ text: "speed test", speed: 1.0 }));
    const r2 = await adapter.synth(req({ text: "speed test", speed: 1.5 }));
    expect(r1.pcm).not.toEqual(r2.pcm);
  });

  it("same speed → identical pcm", async () => {
    const r1 = await adapter.synth(req({ text: "speed test", speed: 1.2 }));
    const r2 = await adapter.synth(req({ text: "speed test", speed: 1.2 }));
    expect(r1.pcm).toEqual(r2.pcm);
  });

  it("undefined speed produces same pcm as explicit speed: 1.0", async () => {
    const r1 = await adapter.synth(req({ text: "default speed", voice: "host" }));
    const r2 = await adapter.synth(req({ text: "default speed", voice: "host", speed: 1.0 }));
    expect(r1.pcm).toEqual(r2.pcm);
  });
});
