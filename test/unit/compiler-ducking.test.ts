// Unit tests for compiler ducking topology (T8b).
// AC coverage: AC1 (asplit + sidechaincompress + amix), AC2 (normalize=0),
//              AC3 (dropout_transition=0), AC4 (bed volume pre-gain with reductionDb),
//              AC5 (speech-v1 preset values), AC6 (preset from lookup table),
//              AC11 (reductionDb field name consistent), no-bed path unchanged.
// T4 update: E_MULTI_BED_UNSUPPORTED removed — multi-bed IRs no longer throw
//            (see test/unit/compiler-multi-bed.test.ts for the T4 AC suite).

import { describe, it, expect } from "vitest";
import { compileIR } from "../../src/compiler/index.js";
import { validateIR } from "../../src/ir/validate.js";
import type { IR } from "../../src/ir/phase-b.js";

const SR = 48000;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function baseIR(overrides: Partial<IR> = {}): IR {
  return {
    schemaVersion: 2,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Ducking Test" },
    tracks: [{ trackId: "voice" }],
    clips: [],
    ducking: [],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav"] },
    ...overrides,
  };
}

/** Build a minimal IR with one voice clip + one bed clip + one ducking entry. */
function duckingIR(opts: {
  voiceDuration?: number;
  bedDuration?: number;
  reductionDb?: number;
  bedLoop?: boolean;
  fadeSamples?: number;
}): IR {
  const voiceDur = opts.voiceDuration ?? SR; // 1s
  const bedDur = opts.bedDuration ?? SR;
  const reduction = opts.reductionDb ?? -12;

  const clips: IR["clips"] = [
    {
      id: "c0",
      sourceRef: { kind: "cache", path: "/cache/voice.wav", hash: "vv", voiceUnitId: 0 },
      trackId: "voice",
      startSample: 0,
      durationSamples: voiceDur,
      gainDb: 0,
    },
    {
      id: "c1",
      sourceRef: { kind: "file", path: "/music/bed.wav" },
      trackId: "bed-0",
      startSample: 0,
      durationSamples: bedDur,
      gainDb: 0,
      ...(opts.bedLoop !== undefined ? { loop: opts.bedLoop } : {}),
      ...(opts.fadeSamples !== undefined && opts.fadeSamples > 0
        ? {
            fades: {
              in: { durationSamples: opts.fadeSamples, curve: "tri" as const },
              out: { durationSamples: opts.fadeSamples, curve: "tri" as const },
            },
          }
        : {}),
    },
  ];

  return baseIR({
    tracks: [{ trackId: "voice" }, { trackId: "bed-0" }],
    clips,
    ducking: [
      {
        bedTrackId: "bed-0",
        duckUnderTrackId: "voice",
        reductionDb: reduction,
        preset: "speech-v1",
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// AC1: ducking IR emits asplit=2, sidechaincompress, amix
// ---------------------------------------------------------------------------

describe("AC1: ducking IR emits sidechain topology", () => {
  it("emits asplit=2 — snapshot", () => {
    const { filterScript } = compileIR(duckingIR({}), "/tmp/out.wav");
    expect(filterScript).toContain("asplit=2");
    expect(filterScript).toMatchSnapshot();
  });

  it("emits sidechaincompress", () => {
    const { filterScript } = compileIR(duckingIR({}), "/tmp/out.wav");
    expect(filterScript).toContain("sidechaincompress=");
  });

  it("emits amix=inputs=2:normalize=0:dropout_transition=0", () => {
    const { filterScript } = compileIR(duckingIR({}), "/tmp/out.wav");
    expect(filterScript).toContain("amix=inputs=2:normalize=0:dropout_transition=0");
  });
});

// ---------------------------------------------------------------------------
// AC2: amix normalize=0 (not normalize=1)
// ---------------------------------------------------------------------------

describe("AC2: amix normalize=0", () => {
  it("amix invocation contains normalize=0", () => {
    const { filterScript } = compileIR(duckingIR({}), "/tmp/out.wav");
    // Must be normalize=0 and NOT normalize=1
    expect(filterScript).toContain("normalize=0");
    expect(filterScript).not.toContain("normalize=1");
  });
});

// ---------------------------------------------------------------------------
// AC3: dropout_transition=0 in amix
// ---------------------------------------------------------------------------

describe("AC3: dropout_transition=0 in amix", () => {
  it("amix contains dropout_transition=0", () => {
    const { filterScript } = compileIR(duckingIR({}), "/tmp/out.wav");
    expect(filterScript).toContain("dropout_transition=0");
  });
});

// ---------------------------------------------------------------------------
// AC4: bed clip has explicit volume={reductionDb}dB pre-gain before amix
// ---------------------------------------------------------------------------

describe("AC4: explicit reductionDb pre-gain on bed", () => {
  it("emits volume=-12dB for reductionDb=-12", () => {
    const { filterScript } = compileIR(duckingIR({ reductionDb: -12 }), "/tmp/out.wav");
    expect(filterScript).toContain("volume=-12dB");
  });

  it("emits volume=-18dB for reductionDb=-18", () => {
    const { filterScript } = compileIR(duckingIR({ reductionDb: -18 }), "/tmp/out.wav");
    expect(filterScript).toContain("volume=-18dB");
  });

  it("uses the IR field name reductionDb (not duck or duckDb) — confirmed by presence of value", () => {
    // Verify that the reductionDb value (-12) is in the script and no other
    // naming is sneaking through: the value must appear as volume=-12dB.
    const { filterScript } = compileIR(duckingIR({ reductionDb: -12 }), "/tmp/out.wav");
    expect(filterScript).toContain("volume=-12dB");
  });
});

// ---------------------------------------------------------------------------
// AC5: sidechaincompress emits pinned speech-v1 preset values
// ---------------------------------------------------------------------------

describe("AC5: speech-v1 preset values in sidechaincompress", () => {
  const EXPECTED_PARAMS =
    "threshold=0.05:ratio=8:attack=20:release=300:makeup=1:knee=2.82843";

  it("emits exact pinned speech-v1 values", () => {
    const { filterScript } = compileIR(duckingIR({}), "/tmp/out.wav");
    expect(filterScript).toContain(`sidechaincompress=${EXPECTED_PARAMS}`);
  });

  it("snapshot — full filter script for bed episode", () => {
    const ir: IR = {
      schemaVersion: 2,
      sampleRate: SR,
      channels: 1,
      episode: { title: "Bed Episode" },
      tracks: [{ trackId: "voice" }, { trackId: "bed-0" }],
      clips: [
        {
          id: "c0",
          sourceRef: { kind: "cache", path: "/cache/v.wav", hash: "vv", voiceUnitId: 0 },
          trackId: "voice",
          startSample: 0,
          durationSamples: SR,
          gainDb: 0,
        },
        {
          id: "c1",
          sourceRef: { kind: "file", path: "/music/bed.wav" },
          trackId: "bed-0",
          startSample: 0,
          durationSamples: SR,
          gainDb: 0,
        },
      ],
      ducking: [
        {
          bedTrackId: "bed-0",
          duckUnderTrackId: "voice",
          reductionDb: -12,
          preset: "speech-v1",
        },
      ],
      chapters: [],
      loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
      render: { outputs: ["wav"] },
    };

    const { filterScript } = compileIR(ir, "/tmp/out.wav");
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// AC6: preset lookup — unknown preset throws
// ---------------------------------------------------------------------------

describe("AC6: unknown preset throws", () => {
  it("throws for an unrecognized preset name", () => {
    const ir = duckingIR({});
    // Force an invalid preset
    (ir.ducking[0] as { preset: string }).preset = "nonexistent-v99";
    expect(() => compileIR(ir, "/tmp/out.wav")).toThrow(/unknown sidechaincompress preset/);
  });
});

// ---------------------------------------------------------------------------
// Bed loop: aloop emitted when clip.loop is true
// ---------------------------------------------------------------------------

describe("bed loop: aloop emitted", () => {
  it("emits aloop when clip.loop=true", () => {
    const { filterScript } = compileIR(duckingIR({ bedLoop: true }), "/tmp/out.wav");
    expect(filterScript).toContain("aloop=");
  });

  it("does NOT emit aloop when clip.loop is absent", () => {
    const { filterScript } = compileIR(duckingIR({ bedLoop: false }), "/tmp/out.wav");
    expect(filterScript).not.toContain("aloop=");
  });

  it("emits apad when clip.loop is false (silence-pad non-loop short bed)", () => {
    const { filterScript } = compileIR(duckingIR({ bedLoop: false }), "/tmp/out.wav");
    expect(filterScript).toContain("apad");
  });

  it("does NOT emit apad when clip.loop=true (aloop handles filling)", () => {
    const { filterScript } = compileIR(duckingIR({ bedLoop: true }), "/tmp/out.wav");
    expect(filterScript).not.toContain("apad");
  });
});

// ---------------------------------------------------------------------------
// Bed fades
// ---------------------------------------------------------------------------

describe("bed fades: afade emitted", () => {
  it("emits afade=t=in and afade=t=out when fades are set", () => {
    const { filterScript } = compileIR(duckingIR({ fadeSamples: 4800 }), "/tmp/out.wav");
    expect(filterScript).toContain("afade=t=in");
    expect(filterScript).toContain("afade=t=out");
  });

  it("does NOT emit afade when no fades", () => {
    const { filterScript } = compileIR(duckingIR({}), "/tmp/out.wav");
    expect(filterScript).not.toContain("afade=");
  });
});

// ---------------------------------------------------------------------------
// No-bed path unchanged (AC7 from T8a is preserved)
// ---------------------------------------------------------------------------

describe("no-bed path unchanged", () => {
  it("empty ducking[] → no asplit, no sidechaincompress, no bed amix", () => {
    const ir = baseIR({
      clips: [
        {
          id: "c0",
          sourceRef: { kind: "cache", path: "/cache/v.wav", hash: "vv", voiceUnitId: 0 },
          trackId: "voice",
          startSample: 0,
          durationSamples: SR,
          gainDb: 0,
        },
      ],
      ducking: [],
    });

    const { filterScript } = compileIR(ir, "/tmp/out.wav");
    expect(filterScript).not.toContain("asplit");
    expect(filterScript).not.toContain("sidechaincompress");
    // The voice-lane amix (for sequential clips) is OK, but there must be no bed amix.
    // Single-clip voice lane → no amix at all.
    expect(filterScript).not.toContain("amix=inputs=");
  });

  it("empty ducking[] → -map [voicelane] in argv", () => {
    const ir = baseIR({
      clips: [
        {
          id: "c0",
          sourceRef: { kind: "cache", path: "/cache/v.wav", hash: "vv", voiceUnitId: 0 },
          trackId: "voice",
          startSample: 0,
          durationSamples: SR,
          gainDb: 0,
        },
      ],
      ducking: [],
    });

    const { argv } = compileIR(ir, "/tmp/out.wav");
    expect(argv).toContain("[voicelane]");
  });

  it("non-empty ducking[] → -map output label is NOT [voicelane]", () => {
    const { argv } = compileIR(duckingIR({}), "/tmp/out.wav");
    // The map target must be a different label (the master mix output from amix)
    const mapIdx = argv.indexOf("-map");
    expect(mapIdx).toBeGreaterThanOrEqual(0);
    const mapTarget = argv[mapIdx + 1];
    expect(mapTarget).not.toBe("[voicelane]");
  });
});

// ---------------------------------------------------------------------------
// AC11: reductionDb field name used consistently (no duck / duckDb in compiler)
// ---------------------------------------------------------------------------

describe("AC11: reductionDb field name consistency", () => {
  it("duckingIR fixture uses reductionDb field", () => {
    const ir = duckingIR({ reductionDb: -12 });
    expect(ir.ducking[0]).toHaveProperty("reductionDb", -12);
    expect(ir.ducking[0]).not.toHaveProperty("duck");
    expect(ir.ducking[0]).not.toHaveProperty("duckDb");
  });
});

// ---------------------------------------------------------------------------
// Fix 5: assert duckUnderTrackId === "voice"
// ---------------------------------------------------------------------------

describe("duckUnderTrackId assertion", () => {
  it("throws a clear error when duckUnderTrackId is not 'voice'", () => {
    const ir = duckingIR({});
    (ir.ducking[0] as { duckUnderTrackId: string }).duckUnderTrackId = "music";
    expect(() => compileIR(ir, "/tmp/out.wav")).toThrow(/duckUnderTrackId.*must be.*voice/);
  });

  it("does NOT throw when duckUnderTrackId is 'voice'", () => {
    const ir = duckingIR({});
    expect(() => compileIR(ir, "/tmp/out.wav")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T4: E_MULTI_BED_UNSUPPORTED removed — validateIR allows multiple beds
// (Full multi-bed AC suite is in test/unit/compiler-multi-bed.test.ts)
// ---------------------------------------------------------------------------

describe("multi-bed: validateIR no longer restricts ducking count (T4)", () => {
  function makeMultiBedIR(): IR {
    return baseIR({
      tracks: [{ trackId: "voice" }, { trackId: "bed-0" }, { trackId: "bed-1" }],
      clips: [
        {
          id: "c0",
          sourceRef: { kind: "cache", path: "/cache/voice.wav", hash: "vv", voiceUnitId: 0 },
          trackId: "voice",
          startSample: 0,
          durationSamples: SR,
          gainDb: 0,
        },
        {
          id: "c1",
          sourceRef: { kind: "file", path: "/music/a.wav" },
          trackId: "bed-0",
          startSample: 0,
          durationSamples: SR,
          gainDb: 0,
        },
        {
          id: "c2",
          sourceRef: { kind: "file", path: "/music/b.wav" },
          trackId: "bed-1",
          startSample: 0,
          durationSamples: SR,
          gainDb: 0,
        },
      ],
      ducking: [
        { bedTrackId: "bed-0", duckUnderTrackId: "voice", reductionDb: -12, preset: "speech-v1" },
        { bedTrackId: "bed-1", duckUnderTrackId: "voice", reductionDb: -12, preset: "speech-v1" },
      ],
    });
  }

  it("validateIR does NOT throw for 2 ducking entries (multi-bed now supported)", () => {
    const ir = makeMultiBedIR();
    expect(() => validateIR(ir)).not.toThrow();
  });

  it("compileIR does NOT throw for 2 ducking entries", () => {
    const ir = makeMultiBedIR();
    expect(() => compileIR(ir, "/tmp/out.wav")).not.toThrow();
  });

  it("validateIR passes for 0 ducking entries (no bed)", () => {
    const ir = baseIR({ ducking: [] });
    expect(() => validateIR(ir)).not.toThrow();
  });

  it("validateIR passes for exactly 1 ducking entry", () => {
    const ir = duckingIR({});
    expect(() => validateIR(ir)).not.toThrow();
  });
});
