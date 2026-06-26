// ffmpeg ducking topology — bed conditioning, aloop, sidechaincompress, amix.
// §5.4: asplit voice → sidechaincompress(bed, voiceKey) → amix normalize=0.
// Pure builder — no I/O; called from index.ts when ducking[] is non-empty.

import type { IR, ClipIR, DuckingIR } from "../ir/phase-b.js";

// ---------------------------------------------------------------------------
// speech-v1 preset (pinned — §5.4 / issue #9)
// ---------------------------------------------------------------------------

interface SidechainPreset {
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  makeup: number;
  knee: number;
}

const PRESETS: Record<string, SidechainPreset> = {
  "speech-v1": {
    threshold: 0.05,
    ratio: 8,
    attack: 20,
    release: 300,
    // makeup=1 is unity gain (multiplier, not dB; range [1,64] in ffmpeg sidechaincompress).
    // Level is controlled solely by the explicit volume=reductionDb pre-gain below.
    makeup: 1,
    knee: 2.82843,
  },
};

function sidechainParams(preset: string): string {
  const p = PRESETS[preset];
  if (!p) throw new Error(`compileIR: unknown sidechaincompress preset "${preset}"`);
  return (
    `threshold=${p.threshold}:ratio=${p.ratio}:attack=${p.attack}` +
    `:release=${p.release}:makeup=${p.makeup}:knee=${p.knee}`
  );
}

// Maximum aloop repeat count — effectively infinite (2^31 - 1).
const ALOOP_MAX = 2147483647;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface BedBuildContext {
  /** Running list of filter lines (mutated in place). */
  lines: string[];
  /** Running list of input paths (mutated in place). */
  inputs: string[];
  /** Single dedup registration function — same Map-backed closure as the voice lane. */
  getInputIndex: (path: string) => number;
  /** Label factory — caller passes its own so the counter stays shared. */
  label: (prefix?: string) => string;
  /** Master sample rate (from ir.sampleRate). */
  masterRate: number;
  /** Universal conditioning string (aresample + aformat). */
  condition: string;
  /** Output channel count (from ir.channels). When 2, buildBedTrack applies a stereo pan filter. */
  channels: 1 | 2;
  /** assertFiniteNumber from caller — reused, not re-declared. */
  assertFinite: (v: unknown, label: string) => number;
}

// ---------------------------------------------------------------------------
// Build one bed track's filter lines.
// Returns the output label for the bed_ducked stream.
// ---------------------------------------------------------------------------

function buildBedTrack(
  bedClips: ClipIR[],
  ctx: BedBuildContext,
): string {
  // All bed clips share the same trackId so we assert there's exactly one
  // (Phase B emits exactly one clip per bed track in v0.1).
  if (bedClips.length !== 1) {
    throw new Error(
      `compileIR: expected exactly 1 bed clip per bed track, got ${bedClips.length}`,
    );
  }
  const clip = bedClips[0]!;
  const { lines, label, condition, assertFinite, getInputIndex } = ctx;

  assertFinite(clip.durationSamples, `bed clip ${clip.id} durationSamples`);

  // Bed clips always have a file sourceRef (kind:"file")
  const src = clip.sourceRef as { kind: "file"; path: string };
  if (src.kind !== "file" || typeof src.path !== "string" || src.path.length === 0) {
    throw new Error(`compileIR: bed clip ${clip.id} must have kind:"file" sourceRef`);
  }

  const idx = getInputIndex(src.path);

  // Condition
  const condLabel = label("b");
  lines.push(`[${idx}:a] ${condition} ${condLabel}`);

  let cur = condLabel;

  // Loop: if clip.loop is true, repeat the source to fill the bed span.
  // aloop=loop=-1 (infinite) combined with atrim end_sample clips to exact span.
  if (clip.loop === true) {
    const loopLabel = label("b");
    lines.push(`${cur} aloop=loop=-1:size=${ALOOP_MAX} ${loopLabel}`);
    cur = loopLabel;
  } else {
    // Non-loop: pad with silence so a source shorter than the span doesn't cut off early.
    // apad produces silence to pad the stream; atrim below clips to the exact span.
    const padLabel = label("b");
    lines.push(`${cur} apad ${padLabel}`);
    cur = padLabel;
  }

  // Trim to bed span (durationSamples at master rate)
  const trimLabel = label("b");
  lines.push(
    `${cur} atrim=start_sample=0:end_sample=${clip.durationSamples}, ` +
    `asetpts=PTS-STARTPTS ${trimLabel}`,
  );
  cur = trimLabel;

  // Fades (afade uses sample domain)
  if (clip.fades) {
    const { in: fadeIn, out: fadeOut } = clip.fades;
    assertFinite(fadeIn.durationSamples, `bed clip ${clip.id} fades.in.durationSamples`);
    assertFinite(fadeOut.durationSamples, `bed clip ${clip.id} fades.out.durationSamples`);
    if (fadeIn.durationSamples > 0) {
      const fl = label("b");
      lines.push(
        `${cur} afade=t=in:ss=0:ns=${fadeIn.durationSamples}:curve=${fadeIn.curve} ${fl}`,
      );
      cur = fl;
    }
    if (fadeOut.durationSamples > 0) {
      // Fade out starts at (durationSamples - fadeOutDuration) samples
      const startSample = clip.durationSamples - fadeOut.durationSamples;
      const fl = label("b");
      lines.push(
        `${cur} afade=t=out:ss=${startSample}:ns=${fadeOut.durationSamples}:curve=${fadeOut.curve} ${fl}`,
      );
      cur = fl;
    }
  }

  // Stereo pan: applied AFTER fades, before delay. Same constant-power law as voice clips.
  // Default pan is 0.0 (center) when clip.pan is absent.
  if (ctx.channels === 2) {
    const pan = clip.pan ?? 0.0;
    ctx.assertFinite(pan, `bed clip ${clip.id} pan`);
    const theta = ((1 + pan) / 2) * (Math.PI / 2);
    const L = Math.cos(theta).toFixed(6);
    const R = Math.sin(theta).toFixed(6);
    const pl = label("b");
    lines.push(`${cur} pan=stereo|c0=${L}*c0|c1=${R}*c0 ${pl}`);
    cur = pl;
  }

  // Delay bed to its absolute timeline position (usually 0 for voice-bed)
  if (clip.startSample > 0) {
    assertFinite(clip.startSample, `bed clip ${clip.id} startSample`);
    const dl = label("b");
    const ptsl = label("b");
    lines.push(`${cur} adelay=delays=${clip.startSample}S:all=1 ${dl}`);
    lines.push(`${dl} asetpts=PTS-STARTPTS ${ptsl}`);
    cur = ptsl;
  }

  return cur;
}

// ---------------------------------------------------------------------------
// Main export: wire voice lane + bed tracks → master mix label.
// Returns the label that should be mapped to output (replaces [voicelane]).
// ---------------------------------------------------------------------------

/**
 * Build the sidechain ducking topology per §5.4.
 *
 * @param voiceLaneLabel  The `[voicelane]` label produced by the voice-lane builder.
 * @param ducking         ir.ducking (non-empty — caller must not call this for empty).
 * @param ir              Full IR (for clip lookup and sampleRate).
 * @param ctx             Shared build context (lines, inputs, label factory, …).
 * @returns               The output label to map to the ffmpeg output (e.g. `[master]`).
 */
export function buildDuckingTopology(
  voiceLaneLabel: string,
  ducking: DuckingIR[],
  ir: IR,
  ctx: BedBuildContext,
): string {
  const { lines, label, assertFinite } = ctx;

  if (ducking.length !== 1) {
    // Defensive assert — validateIR() in compileIR() is the user-facing error path.
    // This branch should be unreachable when compileIR is the caller.
    throw new Error(
      `compileIR: internal assert failed — expected exactly 1 ducking entry, got ${ducking.length}`,
    );
  }

  const duck = ducking[0]!;
  if (duck.duckUnderTrackId !== "voice") {
    throw new Error(
      `compileIR: ducking[0].duckUnderTrackId must be "voice", got "${duck.duckUnderTrackId}"`,
    );
  }
  assertFinite(duck.reductionDb, "ducking[0].reductionDb");

  // --- Build bed track ---
  const bedClips = ir.clips.filter(c => c.trackId === duck.bedTrackId);
  const bedLabel = buildBedTrack(bedClips, ctx);

  // --- asplit voice lane → one copy for mix, one copy to key the compressor ---
  const vcMix = label("vc");
  const vcKeyRaw = label("vc");
  lines.push(`${voiceLaneLabel} asplit=2 ${vcMix}${vcKeyRaw}`);

  // In stereo mode the voice key is panned, so sidechaincompress would reduce each
  // bed channel by that channel's key level only — a voice panned hard-left barely
  // ducks the bed's right channel. Fix: mono-sum the key and broadcast to both
  // channels before sidechaincompress so ducking depth is pan-independent.
  let vcKey = vcKeyRaw;
  if (ctx.channels === 2) {
    const vcKeyMono = label("vc");
    lines.push(`${vcKeyRaw} pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1 ${vcKeyMono}`);
    vcKey = vcKeyMono;
  }

  // --- sidechaincompress: bed input, voice key ---
  const bedDucked = label("bd");
  const params = sidechainParams(duck.preset);
  lines.push(`${bedLabel}${vcKey} sidechaincompress=${params} ${bedDucked}`);

  // --- explicit pre-gain volumes (no auto-normalize) ---
  const vcGain = label("vg");
  const bedGain = label("bg");
  lines.push(`${vcMix} volume=0dB ${vcGain}`);
  lines.push(`${bedDucked} volume=${duck.reductionDb}dB ${bedGain}`);

  // --- amix: normalize=0, dropout_transition=0 ---
  const master = label("m");
  lines.push(`${vcGain}${bedGain} amix=inputs=2:normalize=0:dropout_transition=0 ${master}`);

  return master;
}
