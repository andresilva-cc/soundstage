// ffmpeg compiler — pure function IR → { filterScript, argv, inputs }.
// §5.3, §5.4 (T8a scope): voice lane only.
// When ducking[] is empty, [voicelane] IS the master mix routed to output.

import type { IR, ClipIR } from "../ir/phase-b.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of compileIR — pure graph data; no I/O performed here. */
export interface CompileResult {
  /** Complete filter_complex script string (run.ts writes this to a temp file). */
  filterScript: string;
  /**
   * ffmpeg argv (excluding "ffmpeg" itself).
   * run.ts splices in `-filter_complex_script <tmpfile>` before the output flags.
   * Includes: -i flags, output options.
   */
  argv: string[];
  /** Ordered input file paths corresponding to the -i flags (index N → [N:a]). */
  inputs: string[];
}

// ---------------------------------------------------------------------------
// Label factory
// ---------------------------------------------------------------------------

function makeLabelFactory(): (prefix?: string) => string {
  let n = 0;
  return (prefix = "x") => `[${prefix}${n++}]`;
}

// ---------------------------------------------------------------------------
// Conditioning string (built from the master rate, never a hardcoded constant)
// ---------------------------------------------------------------------------

/**
 * Universal conditioning applied to every file input edge unconditionally (§5.3).
 * Built from masterRate so a non-default <Episode sampleRate> never creates a
 * mismatch between the conditioning filters, silence sources, and the -ar flag.
 *
 * Note: resampler=soxr is omitted — soxr is not available in all ffmpeg builds
 * (Ubuntu apt-get ffmpeg, homebrew without --with-libsoxr).
 */
function makeCondition(masterRate: number): string {
  return (
    `aresample=${masterRate}, ` +
    `aformat=sample_fmts=fltp:channel_layouts=mono:sample_rates=${masterRate}`
  );
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `compileIR: ${label} must be a finite number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Main compiler
// ---------------------------------------------------------------------------

/**
 * Pure function: IR → { filterScript, argv, inputs }.
 * No I/O — side effects (writing temp file, invoking ffmpeg) live in run.ts.
 *
 * T8a scope: voice lane.  ducking[] is ignored (T8b extends this).
 * When ducking[] is empty, [voicelane] routes directly to the output.
 *
 * @param ir      complete IR (§3.2)
 * @param outPath path for the intermediate f32le WAV output
 */
export function compileIR(ir: IR, outPath: string): CompileResult {
  // Validate IR fields that will be interpolated into filter syntax (Fix #5).
  const masterRate = assertFiniteNumber(ir.sampleRate, "ir.sampleRate");
  const condition = makeCondition(masterRate);

  const inputs: string[] = [];
  const lines: string[] = [];
  const label = makeLabelFactory();

  // ---- Map each unique file path to an -i input index ----
  const fileIndex = new Map<string, number>();

  function getInputIndex(path: string): number {
    let idx = fileIndex.get(path);
    if (idx === undefined) {
      idx = inputs.length;
      fileIndex.set(path, idx);
      inputs.push(path);
    }
    return idx;
  }

  // ---- Voice-lane clips ----
  const voiceClips = ir.clips.filter(c => c.trackId === "voice");

  if (voiceClips.length === 0) {
    // Degenerate: emit 1-sample silence so ffmpeg has a valid output.
    // atrim+asetpts after aevalsrc pins the output to exactly 1 sample (§3.2/§8).
    const durationSamples = 1;
    const durationSec = durationSamples / masterRate;
    lines.push(
      `aevalsrc=0:s=${masterRate}:d=${durationSec}, ` +
      `atrim=end_sample=${durationSamples}, asetpts=PTS-STARTPTS [voicelane]`,
    );
  } else {
    // Build voice lane by processing clips left-to-right.
    //
    // Two placement strategies:
    //
    // Sequential (no crossfade): clip is delay-placed at its absolute timeline
    // position and summed with the running lane via amix=normalize=0.
    //
    // Crossfade: acrossfade takes TWO PTS-from-zero inputs (no adelay on the
    // second input) and produces one output of duration (dur1 + dur2 - ns).
    // The second clip MUST NOT be delay-placed — acrossfade handles temporal
    // positioning by concatenating the two streams; an adelay would cause it
    // to produce incorrect (too-short) output. The first clip IS in the running
    // lane which may already be at the correct timeline position.
    //
    // A chain A→CF→B→CF→C folds left-to-right:
    //   step1: acrossfade([A_lane], [B_noDelay]) → AB_lane
    //   step2: acrossfade([AB_lane], [C_noDelay]) → ABC_lane

    // Build the first clip's label (always with delay if needed)
    let lane = buildClipLabel(voiceClips[0]!, getInputIndex, label, lines, masterRate, condition);
    let i = 0;

    while (i < voiceClips.length - 1) {
      const clip = voiceClips[i]!;
      const nextClip = voiceClips[i + 1]!;
      const merged = label("c");

      if (clip.crossfadeIntoNext !== undefined) {
        // Second clip for acrossfade: condition + trim only, NO adelay.
        // (PTS starts at 0 from asetpts=PTS-STARTPTS; acrossfade concatenates sequentially.)
        const rawNext = buildClipLabelNoDelay(nextClip, getInputIndex, label, lines, masterRate, condition);
        const { durationSamples: ns, curve } = clip.crossfadeIntoNext;
        lines.push(`${lane}${rawNext} acrossfade=ns=${ns}:c1=${curve}:c2=${curve} ${merged}`);
        lane = merged;
        i += 1;
        // The next clip (i+1 in the updated i) may itself have a crossfadeIntoNext
        // and must be processed with NO delay (its "placed" position is encoded by
        // the acrossfade output, not by adelay). We continue the while loop normally.
      } else {
        // Sequential: next clip is delay-placed; amix=normalize=0 sums the streams.
        const nextPlaced = buildClipLabel(nextClip, getInputIndex, label, lines, masterRate, condition);
        lines.push(
          `${lane}${nextPlaced} amix=inputs=2:normalize=0:dropout_transition=0 ${merged}`,
        );
        lane = merged;
        i += 1;
      }
    }

    // Route to output
    // T8b will extend this with bed topology; for T8a voicelane = master mix
    lines.push(`${lane} anull [voicelane]`);
  }

  // ---- Assemble filter script ----
  const filterScript = lines.join(";\n") + ";";

  // ---- Build argv ----
  const iFlags: string[] = [];
  for (const path of inputs) {
    iFlags.push("-i", path);
  }

  const outputOpts = [
    "-map", "[voicelane]",
    "-c:a", "pcm_f32le",
    "-ar", String(masterRate),
    "-ac", "1",
    "-y",
    "--",
    outPath,
  ];

  // run.ts will insert [-filter_complex_script <tmpfile>] between iFlags and outputOpts
  const argv = [...iFlags, ...outputOpts];

  return { filterScript, argv, inputs };
}

// ---------------------------------------------------------------------------
// Per-clip label builders
// ---------------------------------------------------------------------------

/**
 * Emit filter lines to condition and place one clip on the timeline.
 * Returns the pad label of the placed (and optionally gained) stream.
 *
 * Key invariant (§5.4):
 *   - atrim trims the SOURCE content to [0, durationSamples] (or clip.trim bounds)
 *     after resampling; start_sample is 0 for untrimmed clips (NOT clip.startSample!)
 *   - adelay positions the trimmed stream at its absolute timeline position
 *   - asetpts=PTS-STARTPTS after adelay resets PTS to 0 so the amix window
 *     starts at the correct absolute position (Fix #4)
 *   - For crossfade second inputs, use buildClipLabelNoDelay instead
 */
function buildClipLabel(
  clip: ClipIR,
  getInputIndex: (path: string) => number,
  label: (prefix?: string) => string,
  lines: string[],
  masterRate: number,
  condition: string,
): string {
  const base = buildClipLabelNoDelay(clip, getInputIndex, label, lines, masterRate, condition);

  // Delay to absolute timeline position (samples, never float seconds).
  // asetpts=PTS-STARTPTS resets PTS after adelay so downstream amix sees
  // PTS from zero for each delayed stream (Fix #4).
  if (clip.startSample > 0) {
    assertFiniteNumber(clip.startSample, `clip ${clip.id} startSample`);
    const delayLabel = label("c");
    const ptsLabel = label("c");
    lines.push(`${base} adelay=delays=${clip.startSample}S:all=1 ${delayLabel}`);
    lines.push(`${delayLabel} asetpts=PTS-STARTPTS ${ptsLabel}`);
    return ptsLabel;
  }

  return base;
}

/**
 * Emit filter lines to condition + trim a clip WITHOUT adelay placement.
 * Used for the second (and subsequent) inputs to acrossfade, which require
 * PTS starting at 0 — acrossfade handles temporal positioning itself.
 */
function buildClipLabelNoDelay(
  clip: ClipIR,
  getInputIndex: (path: string) => number,
  label: (prefix?: string) => string,
  lines: string[],
  masterRate: number,
  condition: string,
): string {
  // Validate numeric fields before interpolating into filter syntax (Fix #5).
  assertFiniteNumber(clip.durationSamples, `clip ${clip.id} durationSamples`);
  assertFiniteNumber(clip.gainDb, `clip ${clip.id} gainDb`);

  if (clip.sourceRef.kind === "silence") {
    // Inline aevalsrc — no file, no -i.
    // aevalsrc's `d` option takes seconds (float); atrim pins the output to
    // exactly durationSamples so there is no ±1-sample drift (§3.2/§8).
    const durationSec = clip.durationSamples / masterRate;
    const outLabel = label("sil");
    lines.push(
      `aevalsrc=0:s=${masterRate}:d=${durationSec}, ` +
      `atrim=end_sample=${clip.durationSamples}, asetpts=PTS-STARTPTS ${outLabel}`,
    );
    return outLabel;
  }

  // Fix #8: narrow the union — kind is "cache" or "file", both have path: string.
  const { kind, path } = clip.sourceRef as { kind: "cache" | "file"; path: string };
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`compileIR: clip ${clip.id} sourceRef.kind="${kind}" has no path`);
  }

  // File input: condition unconditionally (§5.3)
  const idx = getInputIndex(path);
  const condLabel = label("c");
  lines.push(`[${idx}:a] ${condition} ${condLabel}`);

  // Trim to content bounds (post-resample coordinate space).
  // Always trim from 0 (or clip.trim.startSample if explicitly set in the IR).
  const trimStart = clip.trim?.startSample ?? 0;
  const trimEnd = clip.trim?.endSample ?? clip.durationSamples;

  const trimLabel = label("c");
  lines.push(
    `${condLabel} atrim=start_sample=${trimStart}:end_sample=${trimEnd}, ` +
    `asetpts=PTS-STARTPTS ${trimLabel}`,
  );

  let current = trimLabel;

  // Per-clip gain
  if (clip.gainDb !== 0) {
    const gainLabel = label("c");
    lines.push(`${current} volume=${clip.gainDb}dB ${gainLabel}`);
    current = gainLabel;
  }

  return current;
}
