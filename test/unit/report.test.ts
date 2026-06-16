// Unit tests for cache report aggregation (src/cli/report.ts).
// Uses fabricated IR + hit/miss data — no ffmpeg, no filesystem.

import { describe, it, expect } from "vitest";
import { buildCacheReport, formatCacheReport } from "../../src/cli/report.js";
import type { IR, ClipIR } from "../../src/ir/phase-b.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal IR with chapters and voice-lane clips keyed by voiceUnitId. */
function makeIR(
  chapters: Array<{ title: string; startSample: number; endSample: number }>,
  voiceCips: Array<{ voiceUnitId: number; startSample: number }>,
): IR {
  const clips: ClipIR[] = voiceCips.map((v, i) => ({
    id: `c${i}`,
    sourceRef: { kind: "cache", path: `/cache/${v.voiceUnitId}.wav`, voiceUnitId: v.voiceUnitId },
    trackId: "voice",
    startSample: v.startSample,
    durationSamples: 1000,
    gainDb: 0,
  }));

  return {
    schemaVersion: 2,
    sampleRate: 48000,
    channels: 1,
    episode: { title: "Test" },
    tracks: [{ trackId: "voice" }],
    clips,
    ducking: [],
    chapters: chapters.map(ch => ({
      title: ch.title,
      startSample: ch.startSample,
      endSample: ch.endSample,
    })),
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav", "mp3"] },
  };
}

// ---------------------------------------------------------------------------
// Tests: buildCacheReport
// ---------------------------------------------------------------------------

describe("buildCacheReport", () => {
  it("all hits — 2 segments, each with 1 voice", () => {
    const ir = makeIR(
      [
        { title: "Intro", startSample: 0, endSample: 5000 },
        { title: "Outro", startSample: 5000, endSample: 10000 },
      ],
      [
        { voiceUnitId: 0, startSample: 0 },
        { voiceUnitId: 1, startSample: 5000 },
      ],
    );
    const hitSet = new Set([0, 1]);

    const report = buildCacheReport(ir, hitSet, 2);

    expect(report.totalCached).toBe(2);
    expect(report.totalReSynth).toBe(0);
    expect(report.segments).toHaveLength(2);
    expect(report.segments[0]).toEqual({ title: "Intro", cached: 1, reSynth: 0 });
    expect(report.segments[1]).toEqual({ title: "Outro", cached: 1, reSynth: 0 });
  });

  it("all misses — 2 segments, 2 voices each", () => {
    const ir = makeIR(
      [
        { title: "A", startSample: 0, endSample: 10000 },
        { title: "B", startSample: 10000, endSample: 20000 },
      ],
      [
        { voiceUnitId: 0, startSample: 0 },
        { voiceUnitId: 1, startSample: 5000 },
        { voiceUnitId: 2, startSample: 10000 },
        { voiceUnitId: 3, startSample: 15000 },
      ],
    );
    const hitSet = new Set<number>();

    const report = buildCacheReport(ir, hitSet, 4);

    expect(report.totalCached).toBe(0);
    expect(report.totalReSynth).toBe(4);
    expect(report.segments[0]).toEqual({ title: "A", cached: 0, reSynth: 2 });
    expect(report.segments[1]).toEqual({ title: "B", cached: 0, reSynth: 2 });
  });

  it("partial hit — 1/3 re-synth in Topic 2", () => {
    const ir = makeIR(
      [
        { title: "Intro", startSample: 0, endSample: 5000 },
        { title: "Topic 2", startSample: 5000, endSample: 20000 },
        { title: "Outro", startSample: 20000, endSample: 25000 },
      ],
      [
        { voiceUnitId: 0, startSample: 0 },    // Intro
        { voiceUnitId: 1, startSample: 5000 }, // Topic 2 (miss)
        { voiceUnitId: 2, startSample: 10000 },// Topic 2 (hit)
        { voiceUnitId: 3, startSample: 15000 },// Topic 2 (hit)
        { voiceUnitId: 4, startSample: 20000 },// Outro
      ],
    );
    const hitSet = new Set([0, 2, 3, 4]); // voice 1 is a miss

    const report = buildCacheReport(ir, hitSet, 5);

    expect(report.segments[0]).toEqual({ title: "Intro", cached: 1, reSynth: 0 });
    expect(report.segments[1]).toEqual({ title: "Topic 2", cached: 2, reSynth: 1 });
    expect(report.segments[2]).toEqual({ title: "Outro", cached: 1, reSynth: 0 });
    expect(report.totalCached).toBe(4);
    expect(report.totalReSynth).toBe(1);
  });

  it("no chapters — all voices in Uncategorized", () => {
    const ir = makeIR([], [{ voiceUnitId: 0, startSample: 0 }]);
    const hitSet = new Set<number>([0]);

    const report = buildCacheReport(ir, hitSet, 1);

    expect(report.segments).toHaveLength(1);
    expect(report.segments[0]).toEqual({ title: "Uncategorized", cached: 1, reSynth: 0 });
    expect(report.totalCached).toBe(1);
    expect(report.totalReSynth).toBe(0);
  });

  it("no voices — returns empty segments, zero totals", () => {
    const ir = makeIR(
      [{ title: "Intro", startSample: 0, endSample: 5000 }],
      [],
    );
    const hitSet = new Set<number>();

    const report = buildCacheReport(ir, hitSet, 0);

    expect(report.totalCached).toBe(0);
    expect(report.totalReSynth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatCacheReport
// ---------------------------------------------------------------------------

describe("formatCacheReport", () => {
  it("all cached — shows N/N cached per segment", () => {
    const report = {
      segments: [
        { title: "Intro", cached: 2, reSynth: 0 },
        { title: "Outro", cached: 1, reSynth: 0 },
      ],
      totalCached: 3,
      totalReSynth: 0,
    };

    const text = formatCacheReport(report);
    expect(text).toContain("Intro: 2/2 cached");
    expect(text).toContain("Outro: 1/1 cached");
    expect(text).toContain("total: 3/3 cached, 0 re-synth");
  });

  it("partial re-synth — shows re-synth/total re-synth · cached", () => {
    const report = {
      segments: [
        { title: "Topic 2", cached: 2, reSynth: 1 },
      ],
      totalCached: 2,
      totalReSynth: 1,
    };

    const text = formatCacheReport(report);
    expect(text).toContain("Topic 2: 1/3 re-synth · 2 cached");
    expect(text).toContain("total: 2/3 cached, 1 re-synth");
  });

  it("all re-synth — shows N/N re-synth", () => {
    const report = {
      segments: [
        { title: "Cold Start", cached: 0, reSynth: 3 },
      ],
      totalCached: 0,
      totalReSynth: 3,
    };

    const text = formatCacheReport(report);
    expect(text).toContain("Cold Start: 3/3 re-synth");
    expect(text).toContain("total: 0/3 cached, 3 re-synth");
  });

  it("no voices — shows (no voice units)", () => {
    const report = {
      segments: [],
      totalCached: 0,
      totalReSynth: 0,
    };

    const text = formatCacheReport(report);
    expect(text).toContain("(no voice units)");
  });
});
