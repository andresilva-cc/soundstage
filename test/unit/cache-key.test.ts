// Unit tests for deriveKey — adversarial inputs targeting each canonicalization rule.
// Each test catches a distinct class of silent cache collision or spurious miss (§4.5, §9).

import { describe, it, expect, vi } from "vitest";
import { deriveKey } from "../../src/adapters/cache/key.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import type { SynthRequest } from "../../src/adapters/types.js";

const adapter = new SyntheticAdapter();

function req(overrides: Partial<SynthRequest> = {}): SynthRequest {
  return {
    text: "hello world",
    voice: "host",
    sampleRate: 24000,
    ...overrides,
  };
}

describe("deriveKey — case normalization (APFS safety)", () => {
  it("voice Host and host produce the same key", () => {
    const a = deriveKey(req({ voice: "Host" }), adapter);
    const b = deriveKey(req({ voice: "host" }), adapter);
    expect(a).toBe(b);
  });

  it("voice HOST and host produce the same key", () => {
    const a = deriveKey(req({ voice: "HOST" }), adapter);
    const b = deriveKey(req({ voice: "host" }), adapter);
    expect(a).toBe(b);
  });

  it("key is lowercase hex only (APFS case-insensitivity safety)", () => {
    const key = deriveKey(req(), adapter);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deriveKey — key-order independence", () => {
  it("settings with different insertion order produce the same key", () => {
    // Adapters that return settings in different insertion orders.
    const adapterA = new SyntheticAdapter();
    const adapterB = new SyntheticAdapter();
    vi.spyOn(adapterA, "canonicalSettings").mockReturnValue({ b: 1, a: 2 });
    vi.spyOn(adapterB, "canonicalSettings").mockReturnValue({ a: 2, b: 1 });
    const keyA = deriveKey(req(), adapterA);
    const keyB = deriveKey(req(), adapterB);
    expect(keyA).toBe(keyB);
  });
});

describe("deriveKey — text normalization", () => {
  it("CRLF text and LF text produce the same key", () => {
    const a = deriveKey(req({ text: "hello\r\nworld" }), adapter);
    const b = deriveKey(req({ text: "hello\nworld" }), adapter);
    expect(a).toBe(b);
  });

  it("NFD and NFC text produce the same key", () => {
    const nfd = "é"; // e + combining accent
    const nfc = "é"; // precomposed é
    const a = deriveKey(req({ text: nfd }), adapter);
    const b = deriveKey(req({ text: nfc }), adapter);
    expect(a).toBe(b);
  });

  it("collapsed whitespace and runs produce the same key", () => {
    const a = deriveKey(req({ text: "hello   world" }), adapter);
    const b = deriveKey(req({ text: "hello world" }), adapter);
    expect(a).toBe(b);
  });

  it("genuinely different text produces different keys", () => {
    const a = deriveKey(req({ text: "hello" }), adapter);
    const b = deriveKey(req({ text: "world" }), adapter);
    expect(a).not.toBe(b);
  });
});

describe("deriveKey — float stability", () => {
  it("speed 1.1 and 1.10 produce the same key", () => {
    const adapterA = new SyntheticAdapter();
    const adapterB = new SyntheticAdapter();
    vi.spyOn(adapterA, "canonicalSettings").mockReturnValue({ voice: "host", speed: 1.1 });
    vi.spyOn(adapterB, "canonicalSettings").mockReturnValue({ voice: "host", speed: 1.10 });
    const a = deriveKey(req(), adapterA);
    const b = deriveKey(req(), adapterB);
    expect(a).toBe(b);
  });

  it("speed 1.1 and 1.2 produce different keys", () => {
    const adapterA = new SyntheticAdapter();
    const adapterB = new SyntheticAdapter();
    vi.spyOn(adapterA, "canonicalSettings").mockReturnValue({ voice: "host", speed: 1.1 });
    vi.spyOn(adapterB, "canonicalSettings").mockReturnValue({ voice: "host", speed: 1.2 });
    const a = deriveKey(req(), adapterA);
    const b = deriveKey(req(), adapterB);
    expect(a).not.toBe(b);
  });
});

describe("deriveKey — inherited-vs-inline (OD-1 load-bearing scenario)", () => {
  it("inherited speed and inline speed produce the same key given identical effective values", () => {
    // Simulates: <Segment speed={1.0}><Voice voice="Host"> inheriting speed
    // vs <Voice voice="Host" speed={1.0}> setting speed inline.
    // Both arrive at the cache layer with the same effective SynthRequest.
    // The cache key must be derived from effective values, not declaration site.
    const inheritedReq: SynthRequest = {
      text: "hello world",
      voice: "Host", // will be lowercased by deriveKey
      speed: 1.0,    // resolved by inheritance from parent Segment
      sampleRate: 24000,
    };
    const inlineReq: SynthRequest = {
      text: "hello world",
      voice: "Host",
      speed: 1.0,    // explicitly set on Voice
      sampleRate: 24000,
    };
    expect(deriveKey(inheritedReq, adapter)).toBe(deriveKey(inlineReq, adapter));
  });

  it("different effective speed values produce different keys", () => {
    const r1: SynthRequest = { text: "hello", voice: "host", speed: 1.0, sampleRate: 24000 };
    const r2: SynthRequest = { text: "hello", voice: "host", speed: 1.5, sampleRate: 24000 };
    expect(deriveKey(r1, adapter)).not.toBe(deriveKey(r2, adapter));
  });
});

describe("deriveKey — key format", () => {
  it("is 64-character lowercase hex (sha256)", () => {
    const key = deriveKey(req(), adapter);
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it("is stable across calls (deterministic)", () => {
    const a = deriveKey(req(), adapter);
    const b = deriveKey(req(), adapter);
    expect(a).toBe(b);
  });
});
