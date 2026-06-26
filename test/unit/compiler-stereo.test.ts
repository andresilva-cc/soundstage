// Unit tests for Task 3: Stereo Audio End-to-End — compiler changes.
// Pure function tests (no I/O, no ffmpeg) — snapshot + assertion.

import { describe, it, expect } from "vitest";
import { compileIR } from "../../src/compiler/index.js";
import type { IR, ClipIR } from "../../src/ir/phase-b.js";

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
  };
}

function silenceClip(id: string, startSample: number, durationSamples: number): ClipIR {
  return {
    id,
    sourceRef: { kind: "silence" },
    trackId: "voice",
    startSample,
    durationSamples,
    gainDb: 0,
  };
}

function bedClip(id: string, durationSamples: number, pan?: number): ClipIR {
  return {
    id,
    sourceRef: { kind: "file", path: "/music/bed.wav" },
    trackId: "bed-0",
    startSample: 0,
    durationSamples,
    gainDb: 0,
    ...(pan !== undefined ? { pan } : {}),
  };
}

function stereoIR(clips: ClipIR[]): IR {
  return baseIR({
    channels: 2,
    tracks: [{ trackId: "voice" }],
    clips,
  });
}

function stereoBedIR(voiceDuration: number, bedPan?: number): IR {
  const voiceClip = cacheClip("c0", 0, voiceDuration);
  const bed = bedClip("c1", voiceDuration, bedPan);
  return {
    schemaVersion: 3,
    sampleRate: SR,
    channels: 2,
    episode: { title: "Test" },
    tracks: [{ trackId: "voice" }, { trackId: "bed-0" }],
    clips: [voiceClip, bed],
    ducking: [{ bedTrackId: "bed-0", duckUnderTrackId: "voice", reductionDb: -12, preset: "speech-v1" }],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav"] },
  };
}

// ---------------------------------------------------------------------------
// Pan math: constant-power law
// ---------------------------------------------------------------------------

describe("pan math: constant-power law", () => {
  it("center pan (0.0) → L ≈ 0.707107, R ≈ 0.707107 in filter string", () => {
    const { filterScript } = compileIR(stereoIR([cacheClip("c0", 0, SR, 0.0)]), "/tmp/out.wav");
    expect(filterScript).toContain("pan=stereo|c0=0.707107*c0|c1=0.707107*c0");
  });

  it("full-left pan (-1.0) → L = 1.000000, R = 0.000000 in filter string", () => {
    const { filterScript } = compileIR(stereoIR([cacheClip("c0", 0, SR, -1.0)]), "/tmp/out.wav");
    expect(filterScript).toContain("pan=stereo|c0=1.000000*c0|c1=0.000000*c0");
  });

  it("full-right pan (1.0) → L = 0.000000, R = 1.000000 in filter string", () => {
    const { filterScript } = compileIR(stereoIR([cacheClip("c0", 0, SR, 1.0)]), "/tmp/out.wav");
    expect(filterScript).toContain("pan=stereo|c0=0.000000*c0|c1=1.000000*c0");
  });

  it("center pan (0.0) is applied even when pan is explicitly 0", () => {
    // Pan filter must appear for ALL clips in stereo mode
    const { filterScript } = compileIR(stereoIR([cacheClip("c0", 0, SR, 0.0)]), "/tmp/out.wav");
    expect(filterScript).toContain("pan=stereo");
  });

  it("center pan undefined defaults to 0.0 (L≈0.707107) in stereo mode", () => {
    // A clip with no pan prop in stereo mode → pan 0.0 → center
    const { filterScript } = compileIR(stereoIR([cacheClip("c0", 0, SR)]), "/tmp/out.wav");
    expect(filterScript).toContain("pan=stereo|c0=0.707107*c0|c1=0.707107*c0");
  });
});

// ---------------------------------------------------------------------------
// Voice-lane stereo snapshot
// ---------------------------------------------------------------------------

describe("stereo voice-lane snapshot", () => {
  it("stereo IR with one clip produces pan=stereo filter — snapshot", () => {
    const { filterScript } = compileIR(
      stereoIR([cacheClip("c0", 0, SR, 0.0)]),
      "/tmp/out.wav",
    );
    expect(filterScript).toContain("pan=stereo|c0=");
    expect(filterScript).toMatchSnapshot();
  });

  it("stereo IR with two clips — both have pan filters", () => {
    const { filterScript } = compileIR(
      stereoIR([
        cacheClip("c0", 0, SR, -0.5),
        cacheClip("c1", SR, SR, 0.5),
      ]),
      "/tmp/out.wav",
    );
    const panOccurrences = (filterScript.match(/pan=stereo/g) ?? []).length;
    expect(panOccurrences).toBeGreaterThanOrEqual(2);
  });

  it("mono IR does NOT produce pan=stereo filter", () => {
    const { filterScript } = compileIR(
      baseIR({ clips: [cacheClip("c0", 0, SR)] }),
      "/tmp/out.wav",
    );
    expect(filterScript).not.toContain("pan=stereo");
  });
});

// ---------------------------------------------------------------------------
// Stereo bed snapshot
// ---------------------------------------------------------------------------

describe("stereo bed snapshot", () => {
  it("stereo IR with bed has pan=stereo filter in bed section", () => {
    const { filterScript } = compileIR(stereoBedIR(SR), "/tmp/out.wav");
    expect(filterScript).toContain("pan=stereo");
    expect(filterScript).toMatchSnapshot();
  });

  it("mono IR with bed does NOT have pan=stereo in bed section", () => {
    const monoIR: IR = {
      schemaVersion: 3,
      sampleRate: SR,
      channels: 1,
      episode: { title: "Test" },
      tracks: [{ trackId: "voice" }, { trackId: "bed-0" }],
      clips: [
        cacheClip("c0", 0, SR),
        bedClip("c1", SR),
      ],
      ducking: [{ bedTrackId: "bed-0", duckUnderTrackId: "voice", reductionDb: -12, preset: "speech-v1" }],
      chapters: [],
      loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
      render: { outputs: ["wav"] },
    };
    const { filterScript } = compileIR(monoIR, "/tmp/out.wav");
    expect(filterScript).not.toContain("pan=stereo");
  });
});

// ---------------------------------------------------------------------------
// Silence: stereo vs mono
// ---------------------------------------------------------------------------

describe("silence: stereo vs mono", () => {
  it("silence clip in stereo mode emits aevalsrc=exprs=0|0 (two channel expressions)", () => {
    const { filterScript } = compileIR(
      stereoIR([silenceClip("c0", 0, SR)]),
      "/tmp/out.wav",
    );
    // Stereo silence uses exprs=0|0 (one expression per channel).
    // channel_layouts= is not a valid aevalsrc option in ffmpeg 8.
    expect(filterScript).toContain("aevalsrc=exprs=0|0:");
    expect(filterScript).not.toContain("channel_layouts=stereo");
  });

  it("silence clip in mono mode does NOT emit channel_layouts in aevalsrc", () => {
    const { filterScript } = compileIR(
      baseIR({ clips: [silenceClip("c0", 0, SR)] }),
      "/tmp/out.wav",
    );
    expect(filterScript).not.toContain("channel_layouts=stereo");
    // mono silence uses aevalsrc=0:s=... (single expression, no exprs= prefix)
    expect(filterScript).toContain("aevalsrc=0:s=");
  });
});

// ---------------------------------------------------------------------------
// -ac flag
// ---------------------------------------------------------------------------

describe("-ac flag in argv", () => {
  it("-ac 2 in argv for a stereo IR", () => {
    const { argv } = compileIR(stereoIR([cacheClip("c0", 0, SR)]), "/tmp/out.wav");
    const acIdx = argv.indexOf("-ac");
    expect(acIdx).toBeGreaterThanOrEqual(0);
    expect(argv[acIdx + 1]).toBe("2");
  });

  it("-ac 1 in argv for a mono IR (regression)", () => {
    const { argv } = compileIR(baseIR({ clips: [cacheClip("c0", 0, SR)] }), "/tmp/out.wav");
    const acIdx = argv.indexOf("-ac");
    expect(acIdx).toBeGreaterThanOrEqual(0);
    expect(argv[acIdx + 1]).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// BedBuildContext.channels plumbing (structural)
// ---------------------------------------------------------------------------

describe("BedBuildContext.channels plumbing", () => {
  it("stereo bed IR compiles without error", () => {
    expect(() => compileIR(stereoBedIR(SR), "/tmp/out.wav")).not.toThrow();
  });

  it("bed with stereo pan produces pan filter string with correct L/R values", () => {
    // bed panned full-right
    const { filterScript } = compileIR(stereoBedIR(SR, 1.0), "/tmp/out.wav");
    expect(filterScript).toContain("pan=stereo|c0=0.000000*c0|c1=1.000000*c0");
  });

  it("bed panned center (default) has L=R=0.707107", () => {
    const { filterScript } = compileIR(stereoBedIR(SR), "/tmp/out.wav");
    expect(filterScript).toContain("pan=stereo|c0=0.707107*c0|c1=0.707107*c0");
  });
});
