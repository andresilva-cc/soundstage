// Unit tests for KokoroAdapter — no model download, CI-safe.
// Tests id, model, and canonicalSettings without invoking synth().

import { describe, it, expect } from "vitest";
import { KokoroAdapter } from "../../src/adapters/kokoro/index.js";
import type { SynthRequest } from "../../src/adapters/types.js";

// Pin the literal so a wrong DEFAULT_SPEED value can't pass on both sides.
const EXPECTED_DEFAULT_SPEED = 1.0;

function req(overrides: Partial<SynthRequest> = {}): SynthRequest {
  return {
    text: "hello",
    voice: "af_heart",
    sampleRate: 24000,
    ...overrides,
  };
}

const adapter = new KokoroAdapter();

describe("KokoroAdapter — identity", () => {
  it("id is 'kokoro'", () => {
    expect(adapter.id).toBe("kokoro");
  });

  it("model is 'Kokoro-82M-v1.0-ONNX-q8'", () => {
    expect(adapter.model).toBe("Kokoro-82M-v1.0-ONNX-q8");
  });
});

describe("KokoroAdapter — canonicalSettings", () => {
  it("returns speed resolved to 1.0 when speed is undefined", () => {
    const settings = adapter.canonicalSettings(req());
    expect(settings).toEqual({ speed: EXPECTED_DEFAULT_SPEED });
  });

  it("returns the explicit speed when provided", () => {
    const settings = adapter.canonicalSettings(req({ speed: 1.5 }));
    expect(settings).toEqual({ speed: 1.5 });
  });

  it("undefined speed and explicit 1.0 produce the same settings", () => {
    const a = adapter.canonicalSettings(req());
    const b = adapter.canonicalSettings(req({ speed: EXPECTED_DEFAULT_SPEED }));
    expect(a).toEqual(b);
  });

  it("does not include voice in settings (voice is a top-level cache key field)", () => {
    const settings = adapter.canonicalSettings(req({ voice: "af_heart" }));
    expect(settings).not.toHaveProperty("voice");
  });

  it("does not include sampleRate in settings", () => {
    const settings = adapter.canonicalSettings(req({ sampleRate: 48000 }));
    expect(settings).not.toHaveProperty("sampleRate");
  });
});
