// §4.5 — Cache report: per-Segment rollup of Voice cache hit/miss.
// The cache is keyed per-Voice (one TTS call = one cache entry).
// The report rolls per-Voice results up by enclosing Segment for readability.
//
// voiceUnitId is assigned sequentially in Phase A (0, 1, 2, ...).
// Each ChapterIR's [startSample, endSample] span covers the voice clips
// that belong to that Segment. We match voice clips to Segments by checking
// which IR clips (with sourceRef.voiceUnitId) fall within each chapter span.

import type { IR, ChapterIR } from "../ir/phase-b.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SegmentReport {
  title: string;
  cached: number;
  reSynth: number;
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
 * Aggregate per-Voice hit/miss data into a per-Segment cache report.
 *
 * @param ir          The compiled IR (clips with voiceUnitId, chapters with sample spans).
 * @param hitSet      Set of voiceUnitIds that were cache hits.
 * @param totalVoices Total number of Voice nodes (voiceUnitIds 0..totalVoices-1).
 */
export function buildCacheReport(
  ir: IR,
  hitSet: ReadonlySet<number>,
  totalVoices: number,
): CacheReport {
  // Build a lookup: voiceUnitId → startSample (from voice-lane IR clips).
  // This lets us assign each voice unit to its chapter by sample position.
  const voiceUnitToSample = new Map<number, number>();
  for (const clip of ir.clips) {
    if (
      clip.trackId === "voice" &&
      clip.sourceRef.kind === "cache" &&
      clip.sourceRef.voiceUnitId !== undefined
    ) {
      voiceUnitToSample.set(clip.sourceRef.voiceUnitId, clip.startSample);
    }
  }

  const chapters = ir.chapters;

  if (chapters.length === 0) {
    // No segments — single flat report.
    let cached = 0;
    let reSynth = 0;
    for (let id = 0; id < totalVoices; id++) {
      if (hitSet.has(id)) cached++;
      else reSynth++;
    }
    return {
      segments: totalVoices > 0 ? [{ title: "Uncategorized", cached, reSynth }] : [],
      totalCached: cached,
      totalReSynth: reSynth,
    };
  }

  // Count hits/misses per chapter index.
  const chapterCounts = chapters.map(() => ({ cached: 0, reSynth: 0 }));

  for (let id = 0; id < totalVoices; id++) {
    const sample = voiceUnitToSample.get(id);
    if (sample === undefined) continue;

    const chapterIdx = findChapterIndex(chapters, sample);
    if (chapterIdx === -1) continue;

    const counts = chapterCounts[chapterIdx]!;
    if (hitSet.has(id)) {
      counts.cached++;
    } else {
      counts.reSynth++;
    }
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

/**
 * Find the chapter index that contains the given sample position.
 * Returns -1 if no chapter matches.
 * Clamps to the last chapter for samples at or just past the final chapter's endSample.
 */
function findChapterIndex(chapters: readonly ChapterIR[], sample: number): number {
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]!;
    if (sample >= ch.startSample && sample < ch.endSample) {
      return i;
    }
  }
  // Clamp to last chapter for samples at/past the final chapter end.
  if (chapters.length > 0 && sample >= chapters[chapters.length - 1]!.startSample) {
    return chapters.length - 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format the cache report as human-readable lines printed to stdout.
 *
 * Per-segment line examples:
 *   "  Intro: 2/2 cached"
 *   "  Topic 2: 1/3 re-synth · 2 cached"
 *   "  Outro: 1/1 re-synth"
 *
 * Summary line:
 *   "  total: 5/7 cached, 2 re-synth"
 */
export function formatCacheReport(report: CacheReport): string {
  const lines: string[] = [];

  for (const seg of report.segments) {
    const total = seg.cached + seg.reSynth;
    if (total === 0) continue;

    let status: string;
    if (seg.reSynth === 0) {
      status = `${seg.cached}/${total} cached`;
    } else if (seg.cached === 0) {
      status = `${seg.reSynth}/${total} re-synth`;
    } else {
      status = `${seg.reSynth}/${total} re-synth · ${seg.cached} cached`;
    }
    lines.push(`  ${seg.title}: ${status}`);
  }

  const total = report.totalCached + report.totalReSynth;
  if (total === 0) {
    lines.push("  (no voice units)");
  } else {
    lines.push(
      `  total: ${report.totalCached}/${total} cached, ${report.totalReSynth} re-synth`,
    );
  }

  return lines.join("\n");
}
