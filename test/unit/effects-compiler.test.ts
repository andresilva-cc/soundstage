// Unit tests for Task 5: Per-Clip Effects (EQ + Compression) — compiler output.
// Pure function snapshot + assertion tests for filter script generation.
// Verifies: equalizer filter strings, acompressor filter strings, ordering after
// gain and pan, cascaded EQ bands, and effects on <Clip> parity.

import { describe, it, expect } from "vitest";
import { compileIR } from "../../src/compiler/index.js";
import type { IR, ClipIR, ClipEffect } from "../../src/ir/phase-b.js";

const SR = 48000;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function baseIR(overrides: Partial<IR> = {}): IR {
  return {
    schemaVersion: 3,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Test" },
    tracks: [{ trackId: "voice" }],
    clips: [],
    ducking: [],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav"] },
    ...overrides,
  };
}

function cacheClip(
  id: string,
  startSample: number,
  durationSamples: number,
  effects?: ClipEffect[],
  pan?: number,
): ClipIR {
  return {
    id,
    sourceRef: { kind: "cache", path: `/cache/${id}.wav`, hash: id, voiceUnitId: 0 },
    trackId: "voice",
    startSample,
    durationSamples,
    gainDb: 0,
    ...(pan !== undefined ? { pan } : {}),
    ...(effects !== undefined ? { effects } : {}),
  };
}

function fileClip(
  id: string,
  startSample: number,
  durationSamples: number,
  effects?: ClipEffect[],
): ClipIR {
  return {
    id,
    sourceRef: { kind: "file", path: `/audio/${id}.wav` },
    trackId: "voice",
    startSample,
    durationSamples,
    gainDb: 0,
    ...(effects !== undefined ? { effects } : {}),
  };
}

// ---------------------------------------------------------------------------
// EQ filter string
// ---------------------------------------------------------------------------

describe("EQ filter string", () => {
  it("single EQ band emits equalizer= filter", () => {
    const clip = cacheClip("c0", 0, SR, [{ type: "eq", bands: [{ frequency: 1000, gain: -3, width: 1 }] }]);
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    expect(filterScript).toContain("equalizer=f=1000:width_type=o:width=1:g=-3");
  });

  it("EQ band with positive gain emits correct filter", () => {
    const clip = cacheClip("c0", 0, SR, [{ type: "eq", bands: [{ frequency: 500, gain: 6, width: 2 }] }]);
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    expect(filterScript).toContain("equalizer=f=500:width_type=o:width=2:g=6");
  });

  it("two EQ bands emit two cascaded equalizer filters", () => {
    const clip = cacheClip("c0", 0, SR, [{
      type: "eq",
      bands: [
        { frequency: 200, gain: -2, width: 2 },
        { frequency: 1000, gain: -6, width: 1 },
      ],
    }]);
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    expect(filterScript).toContain("equalizer=f=200:width_type=o:width=2:g=-2");
    expect(filterScript).toContain("equalizer=f=1000:width_type=o:width=1:g=-6");
    // Both must appear — cascaded
    const eqCount = (filterScript.match(/equalizer=/g) ?? []).length;
    expect(eqCount).toBe(2);
  });

  it("EQ filter snapshot — single band 1 kHz cut", () => {
    const clip = cacheClip("c0", 0, SR, [{ type: "eq", bands: [{ frequency: 1000, gain: -3, width: 1 }] }]);
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Compressor filter string
// ---------------------------------------------------------------------------

describe("compressor filter string", () => {
  it("compress effect emits acompressor= filter with linear threshold and makeup=1", () => {
    // threshold=-20 dBFS → linear = 10^(-20/20) = 0.1 (exact)
    const clip = cacheClip("c0", 0, SR, [{
      type: "compress",
      threshold: -20,
      ratio: 4,
      attack: 5,
      release: 100,
      knee: 2,
    }]);
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    // threshold is emitted as linear, NOT as dBFS
    expect(filterScript).toContain("threshold=0.1:");
    expect(filterScript).not.toContain("threshold=-20");
    expect(filterScript).toContain("ratio=4:attack=5:release=100:knee=2:makeup=1");
  });

  it("threshold=-60 dBFS clamps to ffmpeg minimum (0.000976563)", () => {
    // 10^(-60/20) = 0.001 — below ffmpeg min of 0.000976563, should clamp
    const clip = cacheClip("c0", 0, SR, [{
      type: "compress",
      threshold: -60,
      ratio: 4,
      attack: 5,
      release: 100,
      knee: 2,
    }]);
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    const match = filterScript.match(/threshold=([\d.e+-]+)/);
    expect(match).toBeTruthy();
    const emitted = parseFloat(match![1]!);
    expect(emitted).toBeGreaterThanOrEqual(0.000976563); // clamped to ffmpeg min
  });

  it("threshold=0 dBFS (unity) emits threshold=1", () => {
    // 10^(0/20) = 1.0 — unity amplitude
    const clip = cacheClip("c0", 0, SR, [{
      type: "compress",
      threshold: 0,
      ratio: 2,
      attack: 10,
      release: 200,
      knee: 2,
    }]);
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    expect(filterScript).toContain("threshold=1:");
  });

  it("compress effect snapshot", () => {
    const clip = cacheClip("c0", 0, SR, [{
      type: "compress",
      threshold: -20,
      ratio: 4,
      attack: 5,
      release: 100,
      knee: 2,
    }]);
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Effects ordering — AFTER gain and pan
// ---------------------------------------------------------------------------

describe("effects ordering — after gain and pan", () => {
  it("equalizer appears after gain filter in the script", () => {
    const clip: ClipIR = {
      id: "c0",
      sourceRef: { kind: "cache", path: "/cache/c0.wav", hash: "c0", voiceUnitId: 0 },
      trackId: "voice",
      startSample: 0,
      durationSamples: SR,
      gainDb: -6, // non-zero gain to emit volume= filter
      effects: [{ type: "eq", bands: [{ frequency: 1000, gain: -3, width: 1 }] }],
    };
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    const gainPos = filterScript.indexOf("volume=");
    const eqPos = filterScript.indexOf("equalizer=");
    expect(gainPos).toBeGreaterThanOrEqual(0);
    expect(eqPos).toBeGreaterThan(gainPos);
  });

  it("in stereo mode, equalizer appears after pan filter", () => {
    const clip = cacheClip("c0", 0, SR, [{ type: "eq", bands: [{ frequency: 1000, gain: -3, width: 1 }] }]);
    const { filterScript } = compileIR(
      baseIR({ channels: 2, clips: [clip] }),
      "/tmp/out.wav",
    );
    const panPos = filterScript.indexOf("pan=stereo");
    const eqPos = filterScript.indexOf("equalizer=");
    expect(panPos).toBeGreaterThanOrEqual(0);
    expect(eqPos).toBeGreaterThan(panPos);
  });

  it("stereo mode: effects after pan — snapshot", () => {
    const clip = cacheClip("c0", 0, SR, [{ type: "eq", bands: [{ frequency: 1000, gain: -3, width: 1 }] }]);
    const { filterScript } = compileIR(
      baseIR({ channels: 2, clips: [clip] }),
      "/tmp/out.wav",
    );
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Effects on <Clip src> — parity with <Voice>
// ---------------------------------------------------------------------------

describe("effects on <Clip src> — parity with <Voice>", () => {
  it("file clip with eq emits equalizer= filter", () => {
    const clip = fileClip("c0", 0, SR, [{ type: "eq", bands: [{ frequency: 800, gain: -4, width: 1 }] }]);
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    expect(filterScript).toContain("equalizer=f=800:width_type=o:width=1:g=-4");
  });

  it("file clip with compress emits acompressor= filter with linear threshold", () => {
    // threshold=-18 dBFS → linear = 10^(-18/20) ≈ 0.12589
    const clip = fileClip("c0", 0, SR, [{
      type: "compress",
      threshold: -18,
      ratio: 3,
      attack: 10,
      release: 200,
      knee: 5,
    }]);
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    // threshold emitted as linear — never as negative dB
    expect(filterScript).not.toContain("threshold=-18");
    expect(filterScript).toContain("ratio=3:attack=10:release=200:knee=5:makeup=1");
    const match = filterScript.match(/threshold=([\d.e+-]+)/);
    expect(match).toBeTruthy();
    const emitted = parseFloat(match![1]!);
    expect(emitted).toBeCloseTo(Math.pow(10, -18 / 20), 5);
  });
});

// ---------------------------------------------------------------------------
// No effects — no extra filters (regression)
// ---------------------------------------------------------------------------

describe("no effects — no extra filters emitted", () => {
  it("clip with no effects has no equalizer= or acompressor= in script", () => {
    const clip = cacheClip("c0", 0, SR);
    const { filterScript } = compileIR(baseIR({ clips: [clip] }), "/tmp/out.wav");
    expect(filterScript).not.toContain("equalizer=");
    expect(filterScript).not.toContain("acompressor=");
  });
});
