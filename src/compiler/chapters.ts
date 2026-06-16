// node-id3 chapter + artwork post-pass — §5.6, issue #11.
// Writes CHAP and CTOC frames (and optionally APIC) to episode.mp3 after encoding.
// ffmpeg omits the CTOC frame for mp3 (trac #7940); this post-pass guarantees
// navigable chapters in podcast players regardless of which ffmpeg is present.
// The WAV master is NOT touched.
//
// NodeID3.write() is used (not update()) because CHAP/CTOC have no updateCompareKey
// in node-id3's merge logic — update() appends new frames on re-render, doubling
// chapters each run. write() strips existing ID3 tags and rewrites from scratch.
// §5.6 states this post-pass is the sole chapter writer; the strip is correct.

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import * as NodeID3 from "node-id3";
import type { ChapterIR, EpisodeIR, IR } from "../ir/phase-b.js";
import { SoundstageError } from "../ir/errors.js";
import { runFfprobe } from "../probe/ffprobe.js";

// ---------------------------------------------------------------------------
// ms conversion
// ---------------------------------------------------------------------------

/**
 * Convert a sample position to milliseconds.
 * Formula (§5.6): ms = Math.round(sample / sampleRate * 1000)
 */
export function samplesToMs(samples: number, sampleRate: number): number {
  return Math.round((samples / sampleRate) * 1000);
}

// ---------------------------------------------------------------------------
// Post-pass
// ---------------------------------------------------------------------------

/**
 * Write CHAP + CTOC frames (and APIC artwork if present) to an mp3 file.
 * Called after encodeMp3(); does not re-encode audio.
 *
 * @param mp3Path      Path to the mp3 file to tag in-place.
 * @param chapters     IR chapters[] (sample-domain spans).
 * @param sampleRate   Master sample rate (used for sample → ms conversion).
 * @param totalSamples Total mix duration in samples.
 *                     MUST be the ffprobe-measured sample count of the rendered
 *                     master WAV — NOT a sum of IR clip durations or a scaled
 *                     cache duration. This value sets the last chapter's endMs;
 *                     a wrong value silently creates a dead zone in podcast players.
 * @param episode      IR episode metadata (artwork path is optional).
 */
export function writeChapterTags(
  mp3Path: string,
  chapters: ChapterIR[],
  sampleRate: number,
  totalSamples: number,
  episode: EpisodeIR,
): void {
  const artworkTags = buildArtworkTags(episode);

  if (chapters.length === 0) {
    // No chapters — write artwork only if present, then return.
    if (!episode.artwork) return;
    const result = NodeID3.write(artworkTags, mp3Path);
    if (result !== true) {
      throw new Error(`node-id3: failed to write artwork tags to ${mp3Path}: ${String(result)}`);
    }
    return;
  }

  const totalMs = samplesToMs(totalSamples, sampleRate);

  // Build chapter entries. The last chapter's endMs is pinned to totalMs so
  // players don't skip/loop past the end (AC: lastChapter.endMs ===
  // Math.round(totalDurationSamples / sampleRate * 1000)).
  const chapterTags: NodeID3.Tags["chapter"] = chapters.map((ch, i) => {
    const isLast = i === chapters.length - 1;
    const endMs = isLast ? totalMs : samplesToMs(ch.endSample, sampleRate);
    return {
      elementID: `chp${i}`,
      startTimeMs: samplesToMs(ch.startSample, sampleRate),
      endTimeMs: endMs,
      tags: { title: ch.title },
    };
  });

  // CTOC: top-level table of contents referencing all chapter element IDs.
  const tableOfContents: NodeID3.Tags["tableOfContents"] = [
    {
      elementID: "toc",
      isOrdered: true,
      elements: chapterTags.map((c: { elementID: string }) => c.elementID),
    },
  ];

  const tags: NodeID3.Tags = {
    chapter: chapterTags,
    tableOfContents,
    ...artworkTags,
  };

  // Use write() (strip + rewrite) not update() — CHAP/CTOC have no
  // updateCompareKey so update() appends frames on re-render (doubled chapters).
  const result = NodeID3.write(tags, mp3Path);
  if (result !== true) {
    throw new Error(`node-id3: failed to write chapter tags to ${mp3Path}: ${String(result)}`);
  }
}

// ---------------------------------------------------------------------------
// Higher-level entry point
// ---------------------------------------------------------------------------

/**
 * Run the chapter/artwork post-pass using the real master WAV duration.
 *
 * ffprobes `masterWavPath` to get the actual total sample count (not an IR
 * estimate), then calls `writeChapterTags`. This is the correct call site for
 * callers that have a rendered master — never pass an IR-summed estimate.
 */
export async function runChapterPostPass(
  ir: IR,
  mp3Path: string,
  masterWavPath: string,
): Promise<void> {
  const { nbSamples, sampleRate, durationTs, durationSec } = await runFfprobe(
    masterWavPath,
    "stream=nb_samples,sample_rate,duration_ts,duration",
  );

  let totalSamples: number;
  if (nbSamples !== undefined) {
    totalSamples = nbSamples;
  } else if (durationTs !== undefined) {
    totalSamples = durationTs;
  } else if (durationSec !== undefined && sampleRate > 0) {
    totalSamples = Math.round(durationSec * sampleRate);
  } else {
    throw new Error(`runChapterPostPass: ffprobe could not determine sample count for ${masterWavPath}`);
  }

  writeChapterTags(mp3Path, ir.chapters, ir.sampleRate, totalSamples, ir.episode);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildArtworkTags(episode: EpisodeIR): NodeID3.Tags {
  if (!episode.artwork) return {};

  let imageBuffer: Buffer;
  try {
    imageBuffer = readFileSync(episode.artwork);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SoundstageError(
      "E_ARTWORK_NOT_FOUND",
      `artwork file not found or unreadable: ${episode.artwork} (${msg})`,
      "episode.artwork",
    );
  }

  return {
    image: {
      mime: artworkMime(episode.artwork),
      type: { id: NodeID3.TagConstants.AttachedPicture.PictureType.FRONT_COVER },
      description: "Cover",
      imageBuffer,
    },
  };
}

/** Derive MIME type from artwork file extension. Defaults to image/png. */
function artworkMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/png"; // png + unknown extensions
}
