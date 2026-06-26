// Unit tests for buildCacheReport / formatCacheReport with the new chunk-stats API (Task 7).
// New signature: buildCacheReport(ir, chunkStats: Map<number, {total, hits}>)
// New format: "Intro: 5/7 chunks cached"

import { describe, it, expect } from "vitest";
import { buildCacheReport, formatCacheReport } from "../../src/cli/report.js";
import type { IR, ClipIR } from "../../src/ir/phase-b.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal IR with chapters and voice-lane clips keyed by voiceUnitId.
 *  Each entry in voiceClips can have multiple clips (to simulate multi-chunk voices). */
function makeIR(
  chapters: Array<{ title: string; startSample: number; endSample: number }>,
  voiceClips: Array<{ voiceUnitId: number; startSample: number; durationSamples?: number }>,
): IR {
  const clips: ClipIR[] = voiceClips.map((v, i) => ({
    id: `c${i}`,
    sourceRef: { kind: "cache", path: `/cache/${i}.wav`, voiceUnitId: v.voiceUnitId },
    trackId: "voice",
    startSample: v.startSample,
    durationSamples: v.durationSamples ?? 1000,
    gainDb: 0,
  }));

  return {
    schemaVersion: 4,
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

function makeChunkStats(
  entries: Array<{ voiceUnitId: number; total: number; hits: number }>,
): Map<number, { total: number; hits: number }> {
  const m = new Map<number, { total: number; hits: number }>();
  for (const e of entries) {
    m.set(e.voiceUnitId, { total: e.total, hits: e.hits });
  }
  return m;
}

// ---------------------------------------------------------------------------
// Tests: buildCacheReport (new signature)
// ---------------------------------------------------------------------------

describe("buildCacheReport (chunk-stats API)", () => {
  it("all hits — 2 voices, 1 chunk each, 2 segments", () => {
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
    const stats = makeChunkStats([
      { voiceUnitId: 0, total: 1, hits: 1 },
      { voiceUnitId: 1, total: 1, hits: 1 },
    ]);

    const report = buildCacheReport(ir, stats);

    expect(report.totalCached).toBe(2);
    expect(report.totalReSynth).toBe(0);
    expect(report.segments).toHaveLength(2);
    expect(report.segments[0]).toEqual({ title: "Intro", cached: 1, reSynth: 0 });
    expect(report.segments[1]).toEqual({ title: "Outro", cached: 1, reSynth: 0 });
  });

  it("multi-chunk voice — 2 voices, voice0 has 3 chunks (2 hits), voice1 has 4 chunks (3 hits)", () => {
    // voice0 → 3 clips in IR (same voiceUnitId=0), positions 0, 10000, 20000
    // voice1 → 4 clips in IR (same voiceUnitId=1), positions 40000, 50000, 60000, 70000
    const ir = makeIR(
      [
        { title: "Intro", startSample: 0, endSample: 35000 },
        { title: "Outro", startSample: 35000, endSample: 80000 },
      ],
      [
        { voiceUnitId: 0, startSample: 0 },
        { voiceUnitId: 0, startSample: 10000 },
        { voiceUnitId: 0, startSample: 20000 },
        { voiceUnitId: 1, startSample: 40000 },
        { voiceUnitId: 1, startSample: 50000 },
        { voiceUnitId: 1, startSample: 60000 },
        { voiceUnitId: 1, startSample: 70000 },
      ],
    );
    const stats = makeChunkStats([
      { voiceUnitId: 0, total: 3, hits: 2 },
      { voiceUnitId: 1, total: 4, hits: 3 },
    ]);

    const report = buildCacheReport(ir, stats);

    expect(report.totalCached).toBe(5); // 2 + 3
    expect(report.totalReSynth).toBe(2); // 1 + 1
    expect(report.segments[0]).toEqual({ title: "Intro", cached: 2, reSynth: 1 });
    expect(report.segments[1]).toEqual({ title: "Outro", cached: 3, reSynth: 1 });
  });

  it("no chapters — single Uncategorized segment with chunk totals", () => {
    const ir = makeIR(
      [],
      [{ voiceUnitId: 0, startSample: 0 }],
    );
    const stats = makeChunkStats([
      { voiceUnitId: 0, total: 2, hits: 1 },
    ]);

    const report = buildCacheReport(ir, stats);

    expect(report.segments).toHaveLength(1);
    expect(report.segments[0]).toEqual({ title: "Uncategorized", cached: 1, reSynth: 1 });
    expect(report.totalCached).toBe(1);
    expect(report.totalReSynth).toBe(1);
  });

  it("empty chunkStats — chapter still appears with zero counts", () => {
    // With no voice clips/chunks but chapters present, the report still contains
    // all chapters (each with 0 cached, 0 reSynth). The segments array is NOT empty;
    // it mirrors the chapters in the IR so the caller can still display section names.
    const ir = makeIR(
      [{ title: "Intro", startSample: 0, endSample: 5000 }],
      [],
    );
    const stats = makeChunkStats([]);

    const report = buildCacheReport(ir, stats);

    expect(report.totalCached).toBe(0);
    expect(report.totalReSynth).toBe(0);
    expect(report.segments).toHaveLength(1);
    expect(report.segments[0]).toEqual({ title: "Intro", cached: 0, reSynth: 0 });
  });

  it("uses FIRST clip's startSample for chapter attribution when voiceUnitId has multiple clips", () => {
    // voiceUnitId=0 has clips at 0, 5000, 10000 → first=0 → in Intro
    // voiceUnitId=1 has clips at 20000, 25000 → first=20000 → in Outro
    const ir = makeIR(
      [
        { title: "Intro", startSample: 0, endSample: 15000 },
        { title: "Outro", startSample: 15000, endSample: 35000 },
      ],
      [
        { voiceUnitId: 0, startSample: 0 },
        { voiceUnitId: 0, startSample: 5000 },
        { voiceUnitId: 0, startSample: 10000 },
        { voiceUnitId: 1, startSample: 20000 },
        { voiceUnitId: 1, startSample: 25000 },
      ],
    );
    const stats = makeChunkStats([
      { voiceUnitId: 0, total: 3, hits: 3 },
      { voiceUnitId: 1, total: 2, hits: 1 },
    ]);

    const report = buildCacheReport(ir, stats);
    expect(report.segments[0]).toEqual({ title: "Intro", cached: 3, reSynth: 0 });
    expect(report.segments[1]).toEqual({ title: "Outro", cached: 1, reSynth: 1 });
  });
});

// ---------------------------------------------------------------------------
// Tests: formatCacheReport (new "chunks cached" format)
// ---------------------------------------------------------------------------

describe("formatCacheReport (chunk format)", () => {
  it("all cached — shows X/Y chunks cached per segment", () => {
    const report = {
      segments: [
        { title: "Intro", cached: 3, reSynth: 0 },
        { title: "Outro", cached: 2, reSynth: 0 },
      ],
      totalCached: 5,
      totalReSynth: 0,
    };

    const text = formatCacheReport(report);
    expect(text).toContain("Intro: 3/3 chunks cached");
    expect(text).toContain("Outro: 2/2 chunks cached");
    expect(text).toContain("total: 5/5 chunks cached");
  });

  it("partial hit — 5/7 chunks cached across 2 segments", () => {
    const report = {
      segments: [
        { title: "Intro", cached: 3, reSynth: 1 },
        { title: "Outro", cached: 2, reSynth: 1 },
      ],
      totalCached: 5,
      totalReSynth: 2,
    };

    const text = formatCacheReport(report);
    expect(text).toContain("5/7 chunks cached");
  });

  it("zero cached — shows 0/N chunks cached", () => {
    const report = {
      segments: [{ title: "Cold Start", cached: 0, reSynth: 3 }],
      totalCached: 0,
      totalReSynth: 3,
    };

    const text = formatCacheReport(report);
    expect(text).toContain("Cold Start: 0/3 chunks cached");
    expect(text).toContain("total: 0/3 chunks cached");
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

  it("segment with title 'Intro' and 5 hits out of 7 total chunks", () => {
    const report = {
      segments: [
        { title: "Intro", cached: 5, reSynth: 2 },
      ],
      totalCached: 5,
      totalReSynth: 2,
    };

    const text = formatCacheReport(report);
    expect(text).toContain("Intro: 5/7 chunks cached");
  });
});
