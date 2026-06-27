// §4.5 — Cache report: per-Segment rollup of Voice chunk cache hit/miss.
// T7: the cache is now keyed per-chunk (one sentence = one cache entry). Each Voice node
// produces N chunks. The report rolls per-chunk results up by enclosing Segment.
//
// voiceUnitId is assigned sequentially in Phase A (0, 1, 2, ...).
// Each ChapterIR's [startSample, endSample] span covers the voice clips
// that belong to that Segment. We match voice clips to Segments by checking
// which IR clips (with sourceRef.voiceUnitId) fall within each chapter span,
// using the FIRST clip's startSample as the representative position for multi-chunk voices.

import type { IR } from "../ir/phase-b.js";
import { findChapterIndex } from "../compiler/chapters.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SegmentReport {
  title: string;
  cached: number;   // number of chunk cache hits in this segment
  reSynth: number;  // number of chunk cache misses (re-synthesized)
}

export interface CacheReport {
  segments: SegmentReport[];
  totalCached: number;
  totalReSynth: number;
}

// ---------------------------------------------------------------------------
// Core aggregation (pure function — unit-testable with fabricated data)
// ---------------------------------------------------------------------------

/**
 * Aggregate per-chunk hit/miss data into a per-Segment cache report.
 *
 * @param ir          The compiled IR (clips with voiceUnitId, chapters with sample spans).
 * @param chunkStats  Map from voiceUnitId → { total: chunk count, hits: cache hit count }.
 *                    Built by the CLI's onVoiceSynthesized callback.
 */
export function buildCacheReport(
  ir: IR,
  chunkStats: ReadonlyMap<number, { total: number; hits: number }>,
): CacheReport {
  // Build a lookup: voiceUnitId → first (minimum) startSample among its clips.
  // Multi-chunk voices produce multiple clips; we use the first clip's position
  // to determine which chapter the voice belongs to.
  const voiceUnitToSample = new Map<number, number>();
  for (const clip of ir.clips) {
    if (
      clip.trackId === "voice" &&
      clip.sourceRef.kind === "cache" &&
      clip.sourceRef.voiceUnitId !== undefined
    ) {
      const id = clip.sourceRef.voiceUnitId;
      const existing = voiceUnitToSample.get(id);
      if (existing === undefined || clip.startSample < existing) {
        voiceUnitToSample.set(id, clip.startSample);
      }
    }
  }

  const chapters = ir.chapters;

  if (chapters.length === 0) {
    // No segments — single flat report.
    let totalCached = 0;
    let totalReSynth = 0;
    for (const stats of chunkStats.values()) {
      totalCached += stats.hits;
      totalReSynth += stats.total - stats.hits;
    }
    const total = totalCached + totalReSynth;
    return {
      segments: total > 0 ? [{ title: "Uncategorized", cached: totalCached, reSynth: totalReSynth }] : [],
      totalCached,
      totalReSynth,
    };
  }

  // Count chunk hits/misses per chapter index.
  const chapterCounts = chapters.map(() => ({ cached: 0, reSynth: 0 }));

  for (const [voiceUnitId, stats] of chunkStats) {
    const sample = voiceUnitToSample.get(voiceUnitId);
    if (sample === undefined) continue;

    const chapterIdx = findChapterIndex(chapters, sample);
    if (chapterIdx === -1) continue;

    const counts = chapterCounts[chapterIdx]!;
    counts.cached += stats.hits;
    counts.reSynth += stats.total - stats.hits;
  }

  let totalCached = 0;
  let totalReSynth = 0;
  const segments: SegmentReport[] = chapters.map((ch, i) => {
    const counts = chapterCounts[i]!;
    totalCached += counts.cached;
    totalReSynth += counts.reSynth;
    return { title: ch.title, cached: counts.cached, reSynth: counts.reSynth };
  });

  return { segments, totalCached, totalReSynth };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format the cache report as human-readable lines printed to stdout.
 *
 * Per-segment line example:
 *   "  Intro: 5/7 chunks cached"
 *   "  Outro: 2/2 chunks cached"
 *
 * Summary line:
 *   "  total: 7/9 chunks cached"
 */
export function formatCacheReport(report: CacheReport): string {
  const lines: string[] = [];

  for (const seg of report.segments) {
    const total = seg.cached + seg.reSynth;
    if (total === 0) continue;
    lines.push(`  ${seg.title}: ${seg.cached}/${total} chunks cached`);
  }

  const total = report.totalCached + report.totalReSynth;
  if (total === 0) {
    lines.push("  (no voice units)");
  } else {
    lines.push(`  total: ${report.totalCached}/${total} chunks cached`);
  }

  return lines.join("\n");
}
