// Unit tests for src/compiler/index.ts — snapshot tests of filter-script strings.
// Pure function (no I/O, no ffmpeg) — every test runs in-process.
// AC coverage: AC1 (single voice), AC2 (two clips + adelay), AC3 (crossfade),
//              AC4 (three clips + two crossfades fold), AC5 (silence), AC6 (temp file path),
//              AC7 (no-ducking no amix).

import { describe, it, expect } from "vitest";
import { compileIR } from "../../src/compiler/index.js";
import type { IR } from "../../src/ir/phase-b.js";

const SR = 48000;

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function baseIR(overrides: Partial<IR> = {}): IR {
  return {
    schemaVersion: 3,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Test Episode" },
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
  path: string,
  hash: string,
  startSample: number,
  durationSamples: number,
  opts: { gainDb?: number; crossfadeIntoNext?: { durationSamples: number; curve: "tri" } } = {},
): IR["clips"][number] {
  return {
    id,
    sourceRef: { kind: "cache", path, hash, voiceUnitId: 0 },
    trackId: "voice",
    startSample,
    durationSamples,
    gainDb: opts.gainDb ?? 0,
    ...(opts.crossfadeIntoNext !== undefined
      ? { crossfadeIntoNext: opts.crossfadeIntoNext }
      : {}),
  };
}

function silenceClip(
  id: string,
  startSample: number,
  durationSamples: number,
): IR["clips"][number] {
  return {
    id,
    sourceRef: { kind: "silence" },
    trackId: "voice",
    startSample,
    durationSamples,
    gainDb: 0,
  };
}

// ---------------------------------------------------------------------------
// AC1: Single-voice IR
// ---------------------------------------------------------------------------

describe("AC1: single voice clip", () => {
  it("emits aresample+aformat conditioning and atrim/asetpts — snapshot", () => {
    const dur = 48000; // 1 second
    const ir = baseIR({
      clips: [cacheClip("c0", ".soundstage/cache/abc.wav", "abc", 0, dur)],
    });

    const { filterScript, argv, inputs } = compileIR(ir, "/tmp/out.wav");

    // filterScript must contain conditioning
    expect(filterScript).toContain("aresample=48000");
    expect(filterScript).toContain("aformat=sample_fmts=fltp:channel_layouts=mono:sample_rates=48000");
    // atrim with start_sample and end_sample
    expect(filterScript).toContain("atrim=start_sample=0:end_sample=48000");
    // PTS reset
    expect(filterScript).toContain("asetpts=PTS-STARTPTS");
    // snapshot
    expect(filterScript).toMatchSnapshot();

    // argv must include the input file
    expect(inputs).toEqual([".soundstage/cache/abc.wav"]);
    expect(argv).toContain("-i");
    expect(argv).toContain(".soundstage/cache/abc.wav");
  });
});

// ---------------------------------------------------------------------------
// AC2: Two-clip sequential (adelay for second clip)
// ---------------------------------------------------------------------------

describe("AC2: two sequential clips", () => {
  it("emits adelay=NS:all=1 for the second clip — snapshot", () => {
    const dur0 = 24000; // 0.5s
    const dur1 = 48000; // 1s
    const ir = baseIR({
      clips: [
        cacheClip("c0", ".soundstage/cache/a.wav", "aaa", 0, dur0),
        cacheClip("c1", ".soundstage/cache/b.wav", "bbb", dur0, dur1),
      ],
    });

    const { filterScript } = compileIR(ir, "/tmp/out.wav");

    // Second clip positioned at sample 24000
    expect(filterScript).toContain("adelay=delays=24000S:all=1");
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// AC3: Crossfade between two clips
// ---------------------------------------------------------------------------

describe("AC3: crossfade between two clips", () => {
  it("emits acrossfade=ns=N:c1=tri:c2=tri — snapshot", () => {
    const overlapSamples = Math.round(0.75 * SR); // 36000
    const dur0 = 48000;
    const dur1 = 48000;
    // With crossfade: second clip starts at dur0 - overlapSamples
    const start1 = dur0 - overlapSamples;

    const ir = baseIR({
      clips: [
        cacheClip("c0", ".soundstage/cache/a.wav", "aaa", 0, dur0, {
          crossfadeIntoNext: { durationSamples: overlapSamples, curve: "tri" },
        }),
        cacheClip("c1", ".soundstage/cache/b.wav", "bbb", start1, dur1),
      ],
    });

    const { filterScript } = compileIR(ir, "/tmp/out.wav");

    expect(filterScript).toContain(`acrossfade=ns=${overlapSamples}:c1=tri:c2=tri`);
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// AC4: Three clips with two crossfades — fold left-to-right
// ---------------------------------------------------------------------------

describe("AC4: three clips with two crossfades fold left-to-right", () => {
  it("emits two acrossfade invocations — snapshot", () => {
    const overlap = Math.round(0.5 * SR); // 24000
    const dur = 48000;

    const ir = baseIR({
      clips: [
        cacheClip("c0", ".soundstage/cache/a.wav", "aaa", 0, dur, {
          crossfadeIntoNext: { durationSamples: overlap, curve: "tri" },
        }),
        cacheClip("c1", ".soundstage/cache/b.wav", "bbb", dur - overlap, dur, {
          crossfadeIntoNext: { durationSamples: overlap, curve: "tri" },
        }),
        cacheClip("c2", ".soundstage/cache/c.wav", "ccc", 2 * dur - 2 * overlap, dur),
      ],
    });

    const { filterScript } = compileIR(ir, "/tmp/out.wav");

    // Two acrossfade calls
    const count = (filterScript.match(/acrossfade/g) ?? []).length;
    expect(count).toBe(2);
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// AC5: Silence clip
// ---------------------------------------------------------------------------

describe("AC5: silence clip", () => {
  it("emits aevalsrc=0 with atrim+asetpts for sample-exact silence — no input file — snapshot", () => {
    const silSamples = Math.round(2 * SR); // 96000
    const ir = baseIR({
      clips: [silenceClip("c0", 0, silSamples)],
    });

    const { filterScript, inputs } = compileIR(ir, "/tmp/out.wav");

    // aevalsrc with atrim+asetpts to pin exact sample count (no float drift)
    const expectedDurSec = silSamples / SR;
    expect(filterScript).toContain(`aevalsrc=0:s=${SR}:d=${expectedDurSec}`);
    expect(filterScript).toContain(`atrim=end_sample=${silSamples}`);
    expect(filterScript).toContain("asetpts=PTS-STARTPTS");
    // No input file for silence
    expect(inputs).toHaveLength(0);
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// AC6: filter script path in argv (not embedded)
// ---------------------------------------------------------------------------

describe("AC6: filter-complex script written to temp file", () => {
  it("argv does not contain the filter-complex script string itself", () => {
    const ir = baseIR({
      clips: [cacheClip("c0", "/cache/a.wav", "aaa", 0, 48000)],
    });

    const { filterScript, argv } = compileIR(ir, "/tmp/out.wav");

    // The filterScript string must NOT appear anywhere in argv
    // (run.ts will write it to a file and pass -filter_complex_script <path>)
    for (const arg of argv) {
      expect(arg).not.toBe(filterScript);
      expect(arg).not.toContain("aresample"); // no filter-graph content in argv
    }

    // argv should contain the output file and audio options
    expect(argv).toContain("/tmp/out.wav");
    expect(argv).toContain("-map");
    expect(argv).toContain("[voicelane]");
  });
});

// ---------------------------------------------------------------------------
// AC7: no ducking → no amix in script
// ---------------------------------------------------------------------------

describe("AC7: no ducking entries → no amix topology", () => {
  it("does not emit amix when ducking[] is empty — snapshot", () => {
    const ir = baseIR({
      clips: [cacheClip("c0", "/cache/a.wav", "aaa", 0, 48000)],
      ducking: [],
    });

    const { filterScript } = compileIR(ir, "/tmp/out.wav");

    // amix should NOT appear (no music bed)
    expect(filterScript).not.toContain("amix=inputs=");
    expect(filterScript).toMatchSnapshot();
  });

  it("does not emit sidechaincompress when ducking[] is empty", () => {
    const ir = baseIR({
      clips: [cacheClip("c0", "/cache/a.wav", "aaa", 0, 48000)],
      ducking: [],
    });

    const { filterScript } = compileIR(ir, "/tmp/out.wav");

    expect(filterScript).not.toContain("sidechaincompress");
  });
});

// ---------------------------------------------------------------------------
// Gain filter
// ---------------------------------------------------------------------------

describe("per-clip gain", () => {
  it("emits volume filter when gainDb != 0", () => {
    const ir = baseIR({
      clips: [cacheClip("c0", "/cache/a.wav", "aaa", 0, 48000, { gainDb: -6 })],
    });

    const { filterScript } = compileIR(ir, "/tmp/out.wav");
    expect(filterScript).toContain("volume=-6dB");
  });

  it("does NOT emit volume filter when gainDb == 0", () => {
    const ir = baseIR({
      clips: [cacheClip("c0", "/cache/a.wav", "aaa", 0, 48000, { gainDb: 0 })],
    });

    const { filterScript } = compileIR(ir, "/tmp/out.wav");
    expect(filterScript).not.toContain("volume=");
  });
});

// ---------------------------------------------------------------------------
// Degenerate: empty clip list
// ---------------------------------------------------------------------------

describe("degenerate: empty voice lane", () => {
  it("emits valid filter script with silence when no clips", () => {
    const ir = baseIR({ clips: [] });
    const { filterScript } = compileIR(ir, "/tmp/out.wav");
    expect(filterScript).toContain("aevalsrc=0");
  });
});
