// Golden tests for Task 5: Per-Clip Effects (EQ + Compression).
//
// EQ test — band-isolated RMS technique:
//   WAV A = 1 kHz sine clip WITH a 12 dB EQ cut at 1 kHz
//   WAV B = same clip, NO cut (reference)
//   Both → narrow bandpass around 1 kHz → RMS via astats
//   Assert: WAV A's 1 kHz-band RMS is ≥ 8 dB below WAV B's
//
// Compression golden test:
//   Uses a loud sine tone (well above threshold) and a quiet reference.
//   Asserts compressor reduces RMS by a measurable range:
//     >= 5 dB (some compression applied) AND <= 30 dB (not over-compressed).
//   This test WOULD FAIL if threshold were emitted as dBFS (-20) instead of
//   linear (0.1), because ffmpeg would clamp to its minimum and over-compress
//   by 40+ dB.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg } from "../../src/compiler/run.js";
import type { IR, ClipEffect } from "../../src/ir/phase-b.js";

const execFileAsync = promisify(execFile);
const SR = 48000;

// ---------------------------------------------------------------------------
// Band-isolated RMS measurement
// ---------------------------------------------------------------------------

/**
 * Measure RMS dBFS of the audio after isolating a narrow band around `centerHz`.
 * Uses ffmpeg equalizer filter in bandpass mode: cuts everything except ±Q octaves
 * around centerHz. The equalizer here is used for its bandpass shape (large gain
 * applied on a copy sent to astats — we use a different approach: just measure
 * output through bandpass filter).
 *
 * We use: bandreject of all bands EXCEPT center, or simpler: run the audio through
 * equalizer with very large positive gain at center and attenuation everywhere else.
 *
 * Actually the simplest approach: pipe through a narrow bandpass using ffmpeg's
 * equalizer filter with a large NEGATIVE gain applied EVERYWHERE except the band
 * of interest. Instead, use `aeval` + FFT or the cleaner approach:
 * use `equalizer=f=center:width_type=o:width=<Q>:g=<large_gain>` to boost the band
 * heavily and use `alimiter` to prevent clipping, then measure RMS.
 *
 * Cleanest approach per the plan: isolate the band with a narrow bandpass filter
 * first, then measure RMS. ffmpeg has `bandpass` filter:
 * `bandpass=f=1000:width_type=o:width=0.5` (narrow bandpass, octave width).
 */
async function probeBandRmsDb(path: string, centerHz: number, widthOctaves = 0.5): Promise<number> {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-y",
    "-i", path,
    "-af", `bandpass=f=${centerHz}:width_type=o:width=${widthOctaves},astats=metadata=1:reset=1`,
    "-f", "null",
    "-",
  ], { encoding: "utf8" }) as { stderr: string };

  const match = stderr.match(/RMS level dB:\s*(-inf|inf|[-\d.]+)/);
  if (!match) {
    throw new Error(`probeBandRmsDb: no RMS level dB in output for ${path}`);
  }
  const val = match[1]!;
  if (val === "-inf") return -Infinity;
  if (val === "inf") return Infinity;
  return parseFloat(val);
}

// ---------------------------------------------------------------------------
// Broadband RMS measurement (for compression golden)
// ---------------------------------------------------------------------------

async function probeRmsDb(path: string): Promise<number> {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-y",
    "-i", path,
    "-af", "astats=metadata=1:reset=1",
    "-f", "null",
    "-",
  ], { encoding: "utf8" }) as { stderr: string };

  // astats emits multiple "RMS level dB" lines (one per channel + overall).
  // Match the last one (overall summary).
  const matches = [...stderr.matchAll(/RMS level dB:\s*(-inf|inf|[-\d.]+)/g)];
  if (matches.length === 0) throw new Error(`probeRmsDb: no RMS level dB in ${path}`);
  const val = matches[matches.length - 1]![1]!;
  if (val === "-inf") return -Infinity;
  return parseFloat(val);
}

// ---------------------------------------------------------------------------
// Test setup: generate a 1 kHz sine WAV and render with / without EQ cut
// ---------------------------------------------------------------------------

let tmpDir: string;
let sineWavPath: string;   // source: 1 kHz sine at 48kHz, 2 seconds
let wavWithEq: string;     // rendered with 1 kHz 12 dB cut
let wavNoEq: string;       // rendered without EQ (reference)
let wavCompressed: string; // rendered with compression applied
let wavUncompressed: string; // same source, no compression (reference)

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-effects-golden-"));

  // Generate a 1 kHz sine wave WAV source file using ffmpeg.
  // 2 seconds at 48kHz, mono, pcm_s16le — compact known-frequency test tone.
  sineWavPath = join(tmpDir, "sine1k.wav");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "sine=frequency=1000:sample_rate=48000:duration=2",
    "-c:a", "pcm_s16le",
    sineWavPath,
  ], { encoding: "utf8" });

  // Build IR for the no-EQ reference
  const noEqIR: IR = {
    schemaVersion: 3,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Effects Golden" },
    tracks: [{ trackId: "voice" }],
    clips: [
      {
        id: "c0",
        sourceRef: { kind: "file", path: sineWavPath },
        trackId: "voice",
        startSample: 0,
        durationSamples: SR * 2,
        gainDb: 0,
      },
    ],
    ducking: [],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav"] },
  };

  // Build IR for the EQ-cut version (12 dB cut at 1 kHz)
  const eqEffect: ClipEffect = {
    type: "eq",
    bands: [{ frequency: 1000, gain: -12, width: 1 }],
  };
  const eqIR: IR = {
    schemaVersion: 3,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Effects Golden EQ" },
    tracks: [{ trackId: "voice" }],
    clips: [
      {
        id: "c0",
        sourceRef: { kind: "file", path: sineWavPath },
        trackId: "voice",
        startSample: 0,
        durationSamples: SR * 2,
        gainDb: 0,
        effects: [eqEffect],
      },
    ],
    ducking: [],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav"] },
  };

  wavNoEq = join(tmpDir, "no-eq.wav");
  wavWithEq = join(tmpDir, "with-eq.wav");

  await runFfmpeg(compileIR(noEqIR, wavNoEq));
  await runFfmpeg(compileIR(eqIR, wavWithEq));

  // Compression golden: full-scale 1 kHz sine (amplitude=1 = 0 dBFS peak, RMS ≈ -3 dBFS).
  // Threshold=-20 dBFS (linear=0.1), ratio=8:1.
  // Input RMS ≈ -3 dBFS = 17 dB above threshold → gain reduction ≈ 15 dB.
  // Correct threshold emission → output ≈ -18 dBFS.
  // Wrong emission (threshold=-20 as dBFS → clamped to ~0.001) → output ≈ -45 dBFS.
  // aevalsrc generates sin() at amplitude 1.0 (0 dBFS peak, RMS ≈ -3 dBFS).
  const loudSineWavPath = join(tmpDir, "loud-sine.wav");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "aevalsrc=sin(2*PI*t*1000):s=48000:d=2",
    "-c:a", "pcm_s16le",
    loudSineWavPath,
  ], { encoding: "utf8" });

  const uncompressedIR: IR = {
    schemaVersion: 3,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Compress Reference" },
    tracks: [{ trackId: "voice" }],
    clips: [
      {
        id: "c0",
        sourceRef: { kind: "file", path: loudSineWavPath },
        trackId: "voice",
        startSample: 0,
        durationSamples: SR * 2,
        gainDb: 0,
      },
    ],
    ducking: [],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav"] },
  };

  const compressEffect: ClipEffect = {
    type: "compress",
    threshold: -20, // dBFS — compiler converts to linear 0.1
    ratio: 8,
    attack: 10,
    release: 150,
    knee: 2,
  };
  const compressedIR: IR = {
    schemaVersion: 3,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Compress Test" },
    tracks: [{ trackId: "voice" }],
    clips: [
      {
        id: "c0",
        sourceRef: { kind: "file", path: loudSineWavPath },
        trackId: "voice",
        startSample: 0,
        durationSamples: SR * 2,
        gainDb: 0,
        effects: [compressEffect],
      },
    ],
    ducking: [],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav"] },
  };

  wavUncompressed = join(tmpDir, "uncompressed.wav");
  wavCompressed = join(tmpDir, "compressed.wav");

  await runFfmpeg(compileIR(uncompressedIR, wavUncompressed));
  await runFfmpeg(compileIR(compressedIR, wavCompressed));
}, 60_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Golden test: EQ cut at 1 kHz — band-isolated RMS comparison
// ---------------------------------------------------------------------------

describe("EQ cut golden test — band-isolated RMS", () => {
  it("1 kHz band RMS is ≥ 8 dB lower in the EQ-cut render vs reference", async () => {
    const refRms = await probeBandRmsDb(wavNoEq, 1000);
    const cutRms = await probeBandRmsDb(wavWithEq, 1000);

    // Both should be real dBFS values (not -Infinity for an active sine)
    expect(refRms).toBeGreaterThan(-Infinity);
    expect(cutRms).toBeGreaterThan(-Infinity);

    const reduction = refRms - cutRms; // positive = cut version is quieter
    expect(reduction).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Golden test: compression — gain reduction verified at audio level
// ---------------------------------------------------------------------------

describe("compression golden test — gain reduction", () => {
  it("compressor reduces RMS by 5–30 dB for a loud signal above threshold", async () => {
    const refRms = await probeRmsDb(wavUncompressed);
    const compRms = await probeRmsDb(wavCompressed);

    expect(refRms).toBeGreaterThan(-Infinity);
    expect(compRms).toBeGreaterThan(-Infinity);

    const reduction = refRms - compRms; // positive = compressed is quieter

    // Some compression must be applied (≥ 5 dB reduction for a signal well above threshold).
    expect(reduction).toBeGreaterThanOrEqual(5);
    // Must NOT be over-compressed (wrong threshold-as-dB would produce 40+ dB reduction).
    expect(reduction).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// Existing goldens regression guard (compile-only — no ffmpeg run needed)
// ---------------------------------------------------------------------------

describe("no effects — existing IR compiles without change", () => {
  it("IR without effects compiles and has no equalizer= or acompressor= in script", () => {
    const ir: IR = {
      schemaVersion: 3,
      sampleRate: SR,
      channels: 1,
      episode: { title: "Regression" },
      tracks: [{ trackId: "voice" }],
      clips: [
        {
          id: "c0",
          sourceRef: { kind: "file", path: "/some/clip.wav" },
          trackId: "voice",
          startSample: 0,
          durationSamples: SR,
          gainDb: 0,
        },
      ],
      ducking: [],
      chapters: [],
      loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
      render: { outputs: ["wav"] },
    };
    const { filterScript } = compileIR(ir, "/tmp/out.wav");
    expect(filterScript).not.toContain("equalizer=");
    expect(filterScript).not.toContain("acompressor=");
  });
});
