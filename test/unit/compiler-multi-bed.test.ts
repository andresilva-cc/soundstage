// Unit tests for T4: Multiple Music Beds.
// ACs covered:
//   AC1  validateIR() does NOT throw for ducking.length > 1
//   AC2  compileIR() with a 2-bed IR does NOT throw (assert at line 181 gone)
//   AC3  per-bed single-clip invariant in buildBedTrack still throws for 2 clips on one bed
//   AC4  2-bed IR emits asplit=3, two sidechaincompress blocks, amix=inputs=3
//   AC5  1-bed IR regression: asplit=2, one sidechaincompress, amix=inputs=2 (snapshot)
//   AC6  3-bed IR emits asplit=4, amix=inputs=4 (snapshot)
//   AC7  two beds with different reductionDb produce different volume= lines (snapshot)
//   AC8  each bed emits its own sidechaincompress block (preset per bed)

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
    schemaVersion: 3,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Multi-Bed Test" },
    tracks: [{ trackId: "voice" }],
    clips: [],
    ducking: [],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav"] },
    ...overrides,
  };
}

/** One voice clip + N bed clips + N ducking entries. */
function multiBedIR(opts: {
  n: number;
  reductionDbs?: number[];
  presets?: string[];
}): IR {
  const n = opts.n;
  const tracks = [
    { trackId: "voice" },
    ...Array.from({ length: n }, (_, i) => ({ trackId: `bed-${i}` })),
  ];

  const clips: IR["clips"] = [
    {
      id: "c0",
      sourceRef: { kind: "cache", path: "/cache/voice.wav", hash: "vv", voiceUnitId: 0 },
      trackId: "voice",
      startSample: 0,
      durationSamples: SR,
      gainDb: 0,
    },
    ...Array.from({ length: n }, (_, i) => ({
      id: `c${i + 1}`,
      sourceRef: { kind: "file" as const, path: `/music/bed${i}.wav` },
      trackId: `bed-${i}`,
      startSample: 0,
      durationSamples: SR,
      gainDb: 0,
    })),
  ];

  const ducking: IR["ducking"] = Array.from({ length: n }, (_, i) => ({
    bedTrackId: `bed-${i}`,
    duckUnderTrackId: "voice",
    reductionDb: opts.reductionDbs?.[i] ?? -12,
    preset: (opts.presets?.[i] ?? "speech-v1") as "speech-v1",
  }));

  return baseIR({ tracks, clips, ducking });
}

/** One voice clip + one bed clip with TWO files on the same bed track (malformed). */
function malformed2ClipBedIR(): IR {
  return baseIR({
    tracks: [{ trackId: "voice" }, { trackId: "bed-0" }],
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
        sourceRef: { kind: "file", path: "/music/bed_a.wav" },
        trackId: "bed-0",
        startSample: 0,
        durationSamples: SR / 2,
        gainDb: 0,
      },
      {
        id: "c2",
        sourceRef: { kind: "file", path: "/music/bed_b.wav" },
        trackId: "bed-0",
        startSample: SR / 2,
        durationSamples: SR / 2,
        gainDb: 0,
      },
    ],
    ducking: [
      { bedTrackId: "bed-0", duckUnderTrackId: "voice", reductionDb: -12, preset: "speech-v1" },
    ],
  });
}

// ---------------------------------------------------------------------------
// AC1: validateIR() does NOT throw for ducking.length > 1
// ---------------------------------------------------------------------------

describe("AC1: validateIR allows multiple ducking entries", () => {
  it("validateIR passes for a 2-bed IR (ducking.length > 1)", () => {
    const ir = multiBedIR({ n: 2 });
    expect(() => validateIR(ir)).not.toThrow();
  });

  it("validateIR passes for a 3-bed IR", () => {
    const ir = multiBedIR({ n: 3 });
    expect(() => validateIR(ir)).not.toThrow();
  });

  it("validateIR still passes for 0 ducking entries", () => {
    const ir = baseIR({ ducking: [] });
    expect(() => validateIR(ir)).not.toThrow();
  });

  it("validateIR still passes for exactly 1 ducking entry", () => {
    const ir = multiBedIR({ n: 1 });
    expect(() => validateIR(ir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC2: compileIR() with a 2-bed IR does NOT throw
// (This verifies the ducking.ts assert at the former line 181 is properly removed.)
// ---------------------------------------------------------------------------

describe("AC2: compileIR() with 2-bed IR does not throw", () => {
  it("compileIR succeeds for a 2-bed IR", () => {
    const ir = multiBedIR({ n: 2 });
    expect(() => compileIR(ir, "/tmp/out.wav")).not.toThrow();
  });

  it("compileIR succeeds for a 3-bed IR", () => {
    const ir = multiBedIR({ n: 3 });
    expect(() => compileIR(ir, "/tmp/out.wav")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC3: per-bed single-clip invariant in buildBedTrack is preserved
// (malformed IR: 1 ducking entry but 2 clips on that bed track → must throw)
// ---------------------------------------------------------------------------

describe("AC3: per-bed single-clip invariant preserved in buildBedTrack", () => {
  it("compileIR throws for a malformed IR with 2 clips on one bed track", () => {
    const ir = malformed2ClipBedIR();
    expect(() => compileIR(ir, "/tmp/out.wav")).toThrow(
      /expected exactly 1 bed clip per bed track/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC4: 2-bed IR topology — asplit=3, two sidechaincompress blocks, amix=inputs=3
// ---------------------------------------------------------------------------

describe("AC4: 2-bed IR topology", () => {
  it("emits asplit=3", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 2 }), "/tmp/out.wav");
    expect(filterScript).toContain("asplit=3");
  });

  it("emits exactly 2 sidechaincompress blocks for 2 beds", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 2 }), "/tmp/out.wav");
    const matches = filterScript.match(/sidechaincompress=/g);
    expect(matches).toHaveLength(2);
  });

  it("emits amix=inputs=3:normalize=0:dropout_transition=0", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 2 }), "/tmp/out.wav");
    expect(filterScript).toContain("amix=inputs=3:normalize=0:dropout_transition=0");
  });

  it("2-bed filter script snapshot", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 2 }), "/tmp/out.wav");
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// AC5: 1-bed regression — asplit=2, one sidechaincompress, amix=inputs=2
// ---------------------------------------------------------------------------

describe("AC5: 1-bed regression (N=1)", () => {
  it("1-bed IR still emits asplit=2", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 1 }), "/tmp/out.wav");
    expect(filterScript).toContain("asplit=2");
    expect(filterScript).not.toContain("asplit=3");
  });

  it("1-bed IR still emits exactly 1 sidechaincompress block", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 1 }), "/tmp/out.wav");
    const matches = filterScript.match(/sidechaincompress=/g);
    expect(matches).toHaveLength(1);
  });

  it("1-bed IR still emits amix=inputs=2:normalize=0:dropout_transition=0", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 1 }), "/tmp/out.wav");
    expect(filterScript).toContain("amix=inputs=2:normalize=0:dropout_transition=0");
  });

  it("1-bed filter script snapshot (regression)", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 1 }), "/tmp/out.wav");
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// AC6: 3-bed IR — asplit=4, amix=inputs=4
// ---------------------------------------------------------------------------

describe("AC6: 3-bed IR topology", () => {
  it("emits asplit=4", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 3 }), "/tmp/out.wav");
    expect(filterScript).toContain("asplit=4");
  });

  it("emits exactly 3 sidechaincompress blocks for 3 beds", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 3 }), "/tmp/out.wav");
    const matches = filterScript.match(/sidechaincompress=/g);
    expect(matches).toHaveLength(3);
  });

  it("emits amix=inputs=4:normalize=0:dropout_transition=0", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 3 }), "/tmp/out.wav");
    expect(filterScript).toContain("amix=inputs=4:normalize=0:dropout_transition=0");
  });

  it("3-bed filter script snapshot", () => {
    const { filterScript } = compileIR(multiBedIR({ n: 3 }), "/tmp/out.wav");
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// AC7: different reductionDb values per bed produce different volume= lines
// ---------------------------------------------------------------------------

describe("AC7: per-bed reductionDb in volume= filter", () => {
  it("two beds with distinct reductionDb values produce distinct volume= lines", () => {
    const { filterScript } = compileIR(
      multiBedIR({ n: 2, reductionDbs: [-12, -18] }),
      "/tmp/out.wav",
    );
    expect(filterScript).toContain("volume=-12dB");
    expect(filterScript).toContain("volume=-18dB");
  });

  it("snapshot with distinct reductionDb values", () => {
    const { filterScript } = compileIR(
      multiBedIR({ n: 2, reductionDbs: [-12, -18] }),
      "/tmp/out.wav",
    );
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// AC8: each bed uses its own preset — both emit separate sidechaincompress blocks
// ---------------------------------------------------------------------------

describe("AC8: per-bed preset — each bed emits its own sidechaincompress", () => {
  it("2-bed IR using speech-v1 for both beds emits 2 sidechaincompress blocks", () => {
    const { filterScript } = compileIR(
      multiBedIR({ n: 2, presets: ["speech-v1", "speech-v1"] }),
      "/tmp/out.wav",
    );
    const matches = filterScript.match(/sidechaincompress=/g);
    expect(matches).toHaveLength(2);
  });
});
