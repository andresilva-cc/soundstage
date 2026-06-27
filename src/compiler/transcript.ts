// Transcript / subtitle export — pure IR → text, no ffmpeg, no network.
// §T1 (Phase 3): generates .srt, .vtt, and .txt artifacts from per-chunk ClipIR
// sample positions. Cue text is the original authored text (ChunkResult.originalText),
// not the cache-key normalization form.

import type { IR } from "../ir/phase-b.js";
import type { SoundstageElement } from "../jsx-runtime/index.js";
import type { ChunkResult } from "../ir/phase-a.js";
import { findChapterIndex } from "./chapters.js";
import { COMPONENT_NAMES } from "../components/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptCue {
  startSample: number;
  endSample: number;
  text: string;
  voiceUnitId: number;
}

// ---------------------------------------------------------------------------
// extractVoiceTexts — walk the Phase A resolved tree
// ---------------------------------------------------------------------------

/**
 * Walk the Phase A resolved tree and collect voiceUnitId → [chunk.originalText, ...]
 * for all Voice nodes. The CLI calls this after phaseA() returns, before Phase B.
 */
export function extractVoiceTexts(resolvedTree: SoundstageElement): Map<number, string[]> {
  const result = new Map<number, string[]>();

  function walk(node: SoundstageElement): void {
    const typeName = typeof node.type === "string" ? node.type : undefined;

    if (typeName === COMPONENT_NAMES.Voice) {
      const voiceUnitId = node.props["voiceUnitId"] as number;
      const chunks = node.props["chunks"] as ChunkResult[];
      result.set(voiceUnitId, chunks.map(c => c.originalText));
    }

    for (const child of node.children) {
      if (child !== null && child !== undefined && typeof child === "object" && "type" in child) {
        walk(child as SoundstageElement);
      }
    }
  }

  walk(resolvedTree);
  return result;
}

// ---------------------------------------------------------------------------
// generateTranscriptCues — IR → cue list
// ---------------------------------------------------------------------------

/**
 * Pure function. Walks ir.clips in order, filtering for voice cache clips.
 * Silence (kind:"silence") and file (kind:"file") clips produce no cue.
 * Applies crossfade clamping (C3) so no two cues overlap.
 *
 * @throws if a voiceUnitId's chunk counter exceeds the available texts in voiceTexts.
 */
export function generateTranscriptCues(
  ir: IR,
  voiceTexts: Map<number, string[]>,
): TranscriptCue[] {
  // Per-voiceUnitId chunk index counter.
  const chunkCounters = new Map<number, number>();

  const cues: TranscriptCue[] = [];

  for (const clip of ir.clips) {
    // Only voice track, cache clips produce cues.
    if (clip.trackId !== "voice") continue;
    if (clip.sourceRef.kind !== "cache") continue;

    const voiceUnitId = clip.sourceRef.voiceUnitId;
    if (voiceUnitId === undefined) continue;

    const texts = voiceTexts.get(voiceUnitId);
    if (texts === undefined) {
      throw new Error(
        `generateTranscriptCues: no originalText entries for voiceUnitId ${voiceUnitId}`,
      );
    }

    const counter = chunkCounters.get(voiceUnitId) ?? 0;
    if (counter >= texts.length) {
      throw new Error(
        `generateTranscriptCues: voiceUnitId ${voiceUnitId} has ${texts.length} text entries but chunk index ${counter} was requested — IR has more clips than originalText entries`,
      );
    }

    const text = texts[counter]!;
    chunkCounters.set(voiceUnitId, counter + 1);

    cues.push({
      startSample: clip.startSample,
      endSample: clip.startSample + clip.durationSamples,
      text,
      voiceUnitId,
    });
  }

  // Sort ascending by startSample (ir.clips should already be in order, but sort
  // is the canonical guarantee).
  cues.sort((a, b) => a.startSample - b.startSample);

  // Crossfade clamping (C3): a <Crossfade> shifts the following clip's startSample
  // earlier, so the preceding clip's endSample may exceed it — producing overlapping
  // SRT/VTT cues. Clamp: cue[i].endSample = min(cue[i].endSample, cue[i+1].startSample).
  // No-op for contiguous (endSample === nextStart) and silence-gap (endSample < nextStart).
  for (let i = 0; i < cues.length - 1; i++) {
    const current = cues[i]!;
    const next = cues[i + 1]!;
    if (current.endSample > next.startSample) {
      current.endSample = next.startSample;
    }
  }

  return cues;
}

// ---------------------------------------------------------------------------
// samplesToTimestamp — shared by SRT and VTT formatters
// ---------------------------------------------------------------------------

/**
 * Convert a sample count to a subtitle timestamp string.
 * Format: "HH:MM:SS<decimalSep>mmm"
 * @param samples  sample position (integer)
 * @param sampleRate  master sample rate (e.g. 48000)
 * @param decimalSep  ',' for SRT, '.' for VTT
 */
export function samplesToTimestamp(
  samples: number,
  sampleRate: number,
  decimalSep: "," | ".",
): string {
  const totalMs = Math.floor((samples / sampleRate) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hours = Math.floor(totalMin / 60);

  const hh = hours.toString().padStart(2, "0");
  const mm = min.toString().padStart(2, "0");
  const ss = sec.toString().padStart(2, "0");
  const mmm = ms.toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}${decimalSep}${mmm}`;
}

// ---------------------------------------------------------------------------
// formatSrt
// ---------------------------------------------------------------------------

/**
 * Format cues as SubRip (.srt).
 * Sequence numbers start at 1. Timestamps use comma decimal separator.
 * Blank line between cues. Trailing newline.
 */
export function formatSrt(cues: TranscriptCue[], sampleRate: number): string {
  if (cues.length === 0) return "";

  const blocks: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const start = samplesToTimestamp(cue.startSample, sampleRate, ",");
    const end = samplesToTimestamp(cue.endSample, sampleRate, ",");
    blocks.push(`${i + 1}\n${start} --> ${end}\n${cue.text}`);
  }
  return blocks.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// formatVtt
// ---------------------------------------------------------------------------

/**
 * Format cues as WebVTT (.vtt).
 * Starts with "WEBVTT\n\n". Timestamps use dot decimal separator.
 * No sequence numbers. Blank line between cues. Trailing newline.
 */
export function formatVtt(cues: TranscriptCue[], sampleRate: number): string {
  const header = "WEBVTT\n\n";
  if (cues.length === 0) return header;

  const blocks: string[] = [];
  for (const cue of cues) {
    const start = samplesToTimestamp(cue.startSample, sampleRate, ".");
    const end = samplesToTimestamp(cue.endSample, sampleRate, ".");
    blocks.push(`${start} --> ${end}\n${cue.text}`);
  }
  return header + blocks.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// formatTxt
// ---------------------------------------------------------------------------

/**
 * Format cues as plain text (.txt).
 * With chapters: prefix each chapter's cues with "## <title>", groups separated
 * by blank lines. Without chapters: cue texts joined by "\n\n". Trailing newline.
 */
export function formatTxt(ir: IR, cues: TranscriptCue[]): string {
  if (cues.length === 0) return "\n";

  if (ir.chapters.length === 0) {
    return cues.map(c => c.text).join("\n\n") + "\n";
  }

  // Group cues by chapter using the same logic as buildCacheReport.
  const chapterGroups: string[][] = ir.chapters.map(() => []);

  for (const cue of cues) {
    const idx = findChapterIndex(ir.chapters, cue.startSample);
    if (idx !== -1) {
      chapterGroups[idx]!.push(cue.text);
    }
  }

  const sections: string[] = [];
  for (let i = 0; i < ir.chapters.length; i++) {
    const chapter = ir.chapters[i]!;
    const texts = chapterGroups[i]!;
    if (texts.length === 0) continue;
    sections.push(`## ${chapter.title}\n\n${texts.join("\n\n")}`);
  }

  return sections.join("\n\n") + "\n";
}
