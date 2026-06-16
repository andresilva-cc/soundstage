// Phase B — Lower to Flat IR.
// §3.1: Pure function (resolved tree) → IR JSON.
// Converts the nested composition tree into a flat, sample-domain clip list
// with absolute start positions, chapter spans, and ducking entries.
// No I/O, no TTS, no ffprobe — fully deterministic.

import type { SoundstageElement } from "../jsx-runtime/index.js";
import { COMPONENT_NAMES } from "../components/types.js";
import { SoundstageError } from "./errors.js";
import { SCHEMA_VERSION } from "../schema-version.js";

const MAX_DEPTH = 100;

// ---------------------------------------------------------------------------
// IR type definitions (§3.2)
// ---------------------------------------------------------------------------

export interface SourceRefIR {
  kind: "cache" | "file" | "silence";
  path?: string;
  hash?: string;
  /** Tree-order index of the originating Voice node (integer; the §3.2 "v3" example is illustrative). */
  voiceUnitId?: number;
}

export interface CrossfadeInfo {
  durationSamples: number;
  curve: "tri";
}

export interface TrimIR {
  startSample: number;
  endSample: number;
}

export interface FadesIR {
  in: { durationSamples: number; curve: "tri" };
  out: { durationSamples: number; curve: "tri" };
}

export interface ClipIR {
  id: string;
  sourceRef: SourceRefIR;
  trackId: string;
  startSample: number;
  durationSamples: number;
  gainDb: number;
  loop?: boolean;
  trim?: TrimIR;
  fades?: FadesIR;
  crossfadeIntoNext?: CrossfadeInfo;
}

export interface TrackIR {
  trackId: string;
}

export interface DuckingIR {
  bedTrackId: string;
  duckUnderTrackId: string;
  reductionDb: number;
  preset: "speech-v1";
}

export interface ChapterIR {
  title: string;
  startSample: number;
  endSample: number;
}

export interface EpisodeIR {
  title: string;
  author?: string;
  artwork?: string;
}

export interface LoudnessIR {
  targetI: number;
  targetTP: number;
  targetLRA: number;
}

export interface RenderIR {
  ffmpegVersion?: string;
  outputs: string[];
}

export interface IR {
  schemaVersion: number;
  sampleRate: number;
  channels: 1;
  episode: EpisodeIR;
  tracks: TrackIR[];
  clips: ClipIR[];
  ducking: DuckingIR[];
  chapters: ChapterIR[];
  loudness: LoudnessIR;
  render: RenderIR;
}

// ---------------------------------------------------------------------------
// Walk state passed through the tree walk
// ---------------------------------------------------------------------------

interface WalkState {
  sampleRate: number;
  clips: ClipIR[];
  ducking: DuckingIR[];
  chapters: ChapterIR[];
  bedCounter: { value: number };
  clipCounter: { value: number };
  depth: number;
}

/**
 * Walk an array of sibling nodes, placing them sequentially.
 * Returns the absolute sample position after the last sibling.
 * @param siblings  resolved-tree nodes to place
 * @param startAt   absolute sample position of the first sibling
 * @param state     mutable walk state (clips / ducking / chapters accumulate here)
 */
function walkSiblings(
  siblings: SoundstageElement["children"],
  startAt: number,
  state: WalkState,
): number {
  if (state.depth > MAX_DEPTH) {
    throw new SoundstageError(
      "E_MAX_DEPTH",
      `Tree exceeds maximum nesting depth of ${MAX_DEPTH}`,
      "<Phase B walk>",
    );
  }

  // Filter out non-element children (text, booleans, nulls)
  const elements = siblings.filter(
    (c): c is SoundstageElement =>
      c !== null && c !== undefined && typeof c === "object" && "type" in c,
  );

  let cursor = startAt;

  // Crossfade is a SEPARATOR — not a clip. It modifies the preceding clip's
  // crossfadeIntoNext and shifts the following clip's start earlier by the overlap.
  // Precondition (guaranteed by validate.ts): no two consecutive Crossfades, and
  // every Crossfade has an audio sibling on each side.

  // pendingCrossfadeOverlap and precedingCrossfadeClip are set together when a
  // Crossfade separator is encountered, then consumed by the immediately following node.
  // Capturing precedingCrossfadeClip at set-time (not re-derived after cursor shift)
  // is essential for correct following-clip overrun detection in chains like
  // [V0, Crossfade, V1, Crossfade, V2] — see arch review W1.
  let pendingCrossfadeOverlap: number | null = null;
  let precedingCrossfadeClip: ClipIR | null = null;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    const typeName = typeof el.type === "string" ? el.type : undefined;

    if (typeName === COMPONENT_NAMES.Crossfade) {
      // Duration in seconds (default 0.75); must be > 0 and finite
      const durationSec = (el.props["duration"] as number | undefined) ?? 0.75;
      if (!isFinite(durationSec) || durationSec <= 0) {
        throw new SoundstageError(
          "E_CROSSFADE_DURATION",
          `<Crossfade> duration must be a positive finite number, got ${durationSec}`,
          "<Crossfade>",
        );
      }
      const overlapSamples = Math.round(durationSec * state.sampleRate);

      const precedingIdx = findLastVoiceClipIndex(state.clips);
      if (precedingIdx === -1) {
        // validate.ts catches missing preceding sibling; this is a defensive guard
        throw new SoundstageError(
          "E_CROSSFADE_BOUNDARY",
          "<Crossfade> has no preceding audio clip",
          "<Crossfade>",
        );
      }
      const prec = state.clips[precedingIdx]!;

      if (overlapSamples > prec.durationSamples) {
        throw new SoundstageError(
          "E_CROSSFADE_DURATION",
          `<Crossfade> durationSamples (${overlapSamples}) exceeds preceding clip durationSamples (${prec.durationSamples})`,
          "<Crossfade>",
        );
      }

      prec.crossfadeIntoNext = { durationSamples: overlapSamples, curve: "tri" };
      cursor -= overlapSamples;
      pendingCrossfadeOverlap = overlapSamples;
      precedingCrossfadeClip = prec;
      continue;
    }

    const nodePlacedStart = cursor;
    const nodeDuration = placeNode(el, nodePlacedStart, state);

    // Check the following clip only when we just applied a crossfade.
    // Use the captured precedingCrossfadeClip — not a re-scan — to avoid the
    // wrong-clip-in-chain bug when multiple crossfades appear in sequence.
    if (pendingCrossfadeOverlap !== null && precedingCrossfadeClip !== null) {
      if (pendingCrossfadeOverlap > nodeDuration) {
        throw new SoundstageError(
          "E_CROSSFADE_DURATION",
          `<Crossfade> durationSamples (${pendingCrossfadeOverlap}) exceeds following clip durationSamples (${nodeDuration})`,
          "<Crossfade>",
        );
      }
      pendingCrossfadeOverlap = null;
      precedingCrossfadeClip = null;
    }

    cursor = nodePlacedStart + nodeDuration;
  }

  return cursor;
}

/**
 * Place a single resolved-tree node at `startSample`.
 * Returns the duration of the placed node in samples.
 * Mutates state (appends clips, ducking, chapters).
 */
function placeNode(
  el: SoundstageElement,
  startSample: number,
  state: WalkState,
): number {
  const typeName = typeof el.type === "string" ? el.type : undefined;

  // --- Voice ---
  if (typeName === COMPONENT_NAMES.Voice) {
    const sourceRef = el.props["sourceRef"] as {
      kind: "cache";
      path: string;
      hash: string;
      voiceUnitId: number;
    };
    const durationSamples = el.props["durationSamples"] as number;

    const clip: ClipIR = {
      id: `c${state.clipCounter.value++}`,
      sourceRef: {
        kind: "cache",
        path: sourceRef.path,
        hash: sourceRef.hash,
        voiceUnitId: sourceRef.voiceUnitId,
      },
      trackId: "voice",
      startSample,
      durationSamples,
      gainDb: 0.0,
    };
    state.clips.push(clip);
    return durationSamples;
  }

  // --- Clip ---
  if (typeName === COMPONENT_NAMES.Clip) {
    const sourceRef = el.props["sourceRef"] as { kind: "file"; path: string };
    const durationSamples = el.props["durationSamples"] as number;
    const gain = (el.props["gain"] as number | undefined) ?? 0.0;

    const clip: ClipIR = {
      id: `c${state.clipCounter.value++}`,
      sourceRef: { kind: "file", path: sourceRef.path },
      trackId: "voice",
      startSample,
      durationSamples,
      gainDb: gain,
    };
    state.clips.push(clip);
    return durationSamples;
  }

  // --- Silence ---
  if (typeName === COMPONENT_NAMES.Silence) {
    const durationSec = el.props["duration"] as number;
    if (!isFinite(durationSec) || durationSec < 0) {
      throw new SoundstageError(
        "E_INVALID_PROP",
        `<Silence> duration must be a finite non-negative number, got ${durationSec}`,
        "<Silence>",
      );
    }
    const durationSamples = Math.round(durationSec * state.sampleRate);

    const clip: ClipIR = {
      id: `c${state.clipCounter.value++}`,
      sourceRef: { kind: "silence" },
      trackId: "voice",
      startSample,
      durationSamples,
      gainDb: 0.0,
    };
    state.clips.push(clip);
    return durationSamples;
  }

  // --- MusicBed ---
  if (typeName === COMPONENT_NAMES.MusicBed) {
    const bedIndex = state.bedCounter.value++;
    const trackId = `bed-${bedIndex}`;
    const sourceRef = el.props["sourceRef"] as { kind: "file"; path: string };
    const duck = (el.props["duck"] as number | undefined) ?? -12;
    const fadeIn = el.props["fadeIn"] as number | undefined;
    const fadeOut = el.props["fadeOut"] as number | undefined;
    const loop = (el.props["loop"] as boolean | undefined) ?? false;

    const childElements = el.children.filter(
      (c): c is SoundstageElement =>
        c !== null && c !== undefined && typeof c === "object" && "type" in c,
    );

    if (childElements.length === 0) {
      return 0;
    }

    const clipsBefore = state.clips.length;
    const childState = { ...state, depth: state.depth + 1 };
    const endCursor = walkSiblings(el.children, startSample, childState);
    // Propagate mutations back (childState shares the same object references for arrays/counters)

    const childClips = state.clips.slice(clipsBefore).filter(c => c.trackId === "voice");
    const firstChildClip = childClips[0];
    const lastChildClip = childClips[childClips.length - 1];

    const bedStart = firstChildClip ? firstChildClip.startSample : startSample;
    const bedEnd = lastChildClip
      ? lastChildClip.startSample + lastChildClip.durationSamples
      : endCursor;
    const bedDuration = bedEnd - bedStart;

    const bedClip: ClipIR = {
      id: `c${state.clipCounter.value++}`,
      sourceRef: { kind: "file", path: sourceRef.path },
      trackId,
      startSample: bedStart,
      durationSamples: bedDuration,
      gainDb: 0.0,
    };

    if (loop) {
      bedClip.loop = true;
    }

    if (fadeIn !== undefined || fadeOut !== undefined) {
      bedClip.fades = {
        in: { durationSamples: fadeIn !== undefined ? Math.round(fadeIn * state.sampleRate) : 0, curve: "tri" },
        out: { durationSamples: fadeOut !== undefined ? Math.round(fadeOut * state.sampleRate) : 0, curve: "tri" },
      };
    }

    state.clips.push(bedClip);

    state.ducking.push({
      bedTrackId: trackId,
      duckUnderTrackId: "voice",
      reductionDb: duck,
      preset: "speech-v1",
    });

    return bedEnd - startSample;
  }

  // --- Segment ---
  if (typeName === COMPONENT_NAMES.Segment) {
    const title = el.props["title"] as string | undefined;
    const clipsBefore = state.clips.length;
    const childState = { ...state, depth: state.depth + 1 };
    const endCursor = walkSiblings(el.children, startSample, childState);

    if (title !== undefined) {
      const childClips = state.clips.slice(clipsBefore).filter(c => c.trackId === "voice");
      const firstClip = childClips[0];
      const lastClip = childClips[childClips.length - 1];

      if (firstClip !== undefined && lastClip !== undefined) {
        state.chapters.push({
          title,
          startSample: firstClip.startSample,
          endSample: lastClip.startSample + lastClip.durationSamples,
        });
      }
    }

    return endCursor - startSample;
  }

  // --- Episode (defensive — should not appear as a child) ---
  if (typeName === COMPONENT_NAMES.Episode) {
    const childState = { ...state, depth: state.depth + 1 };
    const endCursor = walkSiblings(el.children, startSample, childState);
    return endCursor - startSample;
  }

  // Unknown node type — recurse into children transparently
  const childState = { ...state, depth: state.depth + 1 };
  const endCursor = walkSiblings(el.children, startSample, childState);
  return endCursor - startSample;
}

/** Returns the index of the last voice-lane clip in clips[], or -1 if none. */
function findLastVoiceClipIndex(clips: ClipIR[]): number {
  for (let i = clips.length - 1; i >= 0; i--) {
    if (clips[i]!.trackId === "voice") return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Phase B: lower a Phase A resolved tree into a flat IR.
 * Pure function — no I/O, no side effects. Same input → same output.
 *
 * @param resolvedTree  The output of Phase A (every leaf has sourceRef + durationSamples).
 * @returns             A complete IR object (§3.2).
 */
export function phaseB(resolvedTree: SoundstageElement): IR {
  const props = resolvedTree.props;
  const sampleRate = (props["sampleRate"] as number | undefined) ?? 48000;
  const episodeTitle = props["title"] as string;
  const episodeAuthor = props["author"] as string | undefined;
  const episodeArtwork = props["artwork"] as string | undefined;

  const state: WalkState = {
    sampleRate,
    clips: [],
    ducking: [],
    chapters: [],
    bedCounter: { value: 0 },
    clipCounter: { value: 0 },
    depth: 0,
  };

  walkSiblings(resolvedTree.children, 0, state);

  // Collect tracks: voice first, then bed-N in index order
  const trackIds = new Set<string>(["voice"]);
  for (const duck of state.ducking) {
    trackIds.add(duck.bedTrackId);
  }
  const tracks: TrackIR[] = [{ trackId: "voice" }];
  const bedTracks = [...trackIds]
    .filter(id => id.startsWith("bed-"))
    .sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));
  for (const id of bedTracks) {
    tracks.push({ trackId: id });
  }

  const episode: EpisodeIR = { title: episodeTitle };
  if (episodeAuthor !== undefined) episode.author = episodeAuthor;
  if (episodeArtwork !== undefined) episode.artwork = episodeArtwork;

  return {
    schemaVersion: SCHEMA_VERSION,
    sampleRate,
    channels: 1,
    episode,
    tracks,
    clips: state.clips,
    ducking: state.ducking,
    chapters: state.chapters,
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav", "mp3"] },
  };
}
