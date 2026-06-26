// Golden tests for T4: Multiple Music Beds.
//
// ACs:
//   DUR   2-bed mono render: ffprobe duration within +-100 samples of voice span
//   DUCK  bed-0 ducks >=6 dB AND bed-1 ducks >=6 dB, verified from the REAL
//         compileIR() output via per-band RMS measurement.
//         Beds are at 5 kHz (bed-0) and 9 kHz (bed-1) -- well above the
//         SyntheticAdapter voice range (200-2000 Hz) -- so two cascaded 2nd-order
//         Butterworth bandpass filters isolate each bed with >24 dB voice rejection.
//         Failure modes caught: silenced bed, shared-duck bug, wrong-wired amix.
//   REG   1-bed render still exits 0 and produces non-empty output.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg } from "../../src/compiler/run.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import type { IR } from "../../src/ir/phase-b.js";

const execFileAsync = promisify(execFile);
const SR = 48000;

// Bed frequencies -- must be above the SyntheticAdapter voice range (200-2000 Hz)
// so that per-band RMS measurement has no voice contamination.
const BED0_FREQ_HZ = 5000;
const BED1_FREQ_HZ = 9000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Measure RMS dBFS in a frequency band over a time window.
 * Cascades two 2nd-order highpass + two 2nd-order lowpass filters (~48 dB/octave
 * rolloff) for >24 dB rejection of SyntheticAdapter voice (200-2000 Hz) when the
 * band is centered above 4 kHz.
 */
async function probeRmsDbBandpass(
  path: string,
  startSample: number,
  endSample: number,
  loHz: number,
  hiHz: number,
): Promise<number> {
  const startSec = startSample / SR;
  const durationSec = (endSample - startSample) / SR;
  // Cascade 2x highpass + 2x lowpass (each 2nd-order) for ~48 dB/octave rolloff
  const af = `highpass=f=${loHz},highpass=f=${loHz},lowpass=f=${hiHz},lowpass=f=${hiHz},astats=metadata=1:reset=1`;

  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-ss", String(startSec),
      "-t", String(durationSec),
      "-i", path,
      "-af", af,
      "-f", "null",
      "-",
    ],
    { encoding: "utf8" },
  ) as { stderr: string };

  const match = stderr.match(/RMS level dB:\s*(-inf|inf|[-\d.]+)/);
  if (!match) throw new Error(`astats RMS parse failed for ${path} (band ${loHz}-${hiHz} Hz)`);
  const val = match[1]!;
  if (val === "-inf") return -Infinity;
  if (val === "inf") return +Infinity;
  return parseFloat(val);
}

/** Run ffprobe and return audio duration in samples. */
async function probeSamples(path: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=nb_samples,sample_rate,duration",
      "-of", "json",
      path,
    ],
    { encoding: "utf8" },
  ) as { stdout: string };

  const parsed = JSON.parse(stdout) as {
    streams: Array<{
      nb_samples?: string | number;
      sample_rate?: string | number;
      duration?: string;
    }>;
  };
  const s = parsed.streams[0];
  if (!s) throw new Error(`ffprobe: no stream in ${path}`);

  if (s.nb_samples !== undefined) {
    const n =
      typeof s.nb_samples === "string"
        ? parseInt(s.nb_samples, 10)
        : Math.trunc(s.nb_samples);
    if (n > 0) return n;
  }
  if (s.duration !== undefined && s.sample_rate !== undefined) {
    const dur = parseFloat(s.duration);
    const rate =
      typeof s.sample_rate === "string"
        ? parseInt(s.sample_rate, 10)
        : Math.trunc(s.sample_rate);
    if (Number.isFinite(dur) && rate > 0) return Math.round(dur * rate);
  }
  throw new Error(`ffprobe: could not determine duration for ${path}`);
}

/** Generate a pure sine WAV at the given frequency via ffmpeg lavfi. */
async function makeSineWav(
  outPath: string,
  freqHz: number,
  durationSec: number,
  sampleRate = 24000,
): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f", "lavfi",
      "-i", `sine=frequency=${freqHz}:sample_rate=${sampleRate}:duration=${durationSec}`,
      "-c:a", "pcm_f32le",
      "--",
      outPath,
    ],
    { encoding: "utf8" },
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`makeSineWav failed: ${msg}`);
  });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let cacheDir: string;

let wavVoice: string; // synthesized voice WAV (SyntheticAdapter, 24kHz)
let durVoice: number; // duration in samples at 48kHz (x2 from 24k)

// Bed WAV files -- frequencies above SyntheticAdapter voice range (200-2000 Hz)
// so that bandpass measurement isolates each bed with minimal voice leakage.
let wavBed0: string;
let wavBed1: string;

const GAP_SEC = 1.0;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-multi-bed-golden-"));
  cacheDir = join(tmpDir, "cache");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cacheDir, { recursive: true });

  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDir);

  const res = await cache.get({
    text: "multi bed golden test voice segment",
    voice: "host",
    sampleRate: 24000,
  });
  wavVoice = res.wavPath;
  durVoice = res.durationSamples * 2; // 24k -> 48k

  wavBed0 = join(tmpDir, `bed0_${BED0_FREQ_HZ}hz.wav`);
  wavBed1 = join(tmpDir, `bed1_${BED1_FREQ_HZ}hz.wav`);

  await Promise.all([
    makeSineWav(wavBed0, BED0_FREQ_HZ, 10, 24000),
    makeSineWav(wavBed1, BED1_FREQ_HZ, 10, 24000),
  ]);
}, 60_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function build2BedIR(opts: {
  voiceDurationSamples: number;
  gapSamples: number;
  bed0ReductionDb?: number;
  bed1ReductionDb?: number;
}): IR {
  const { voiceDurationSamples: dur, gapSamples: gap } = opts;
  const r0 = opts.bed0ReductionDb ?? -12;
  const r1 = opts.bed1ReductionDb ?? -18;
  const spanSamples = dur + gap + dur;

  return {
    schemaVersion: 3,
    sampleRate: SR,
    channels: 1,
    episode: { title: "2-Bed Golden" },
    tracks: [{ trackId: "voice" }, { trackId: "bed-0" }, { trackId: "bed-1" }],
    clips: [
      {
        id: "c0",
        sourceRef: { kind: "cache", path: wavVoice, hash: "vv", voiceUnitId: 0 },
        trackId: "voice",
        startSample: 0,
        durationSamples: dur,
        gainDb: 0,
      },
      {
        id: "c1",
        sourceRef: { kind: "silence" },
        trackId: "voice",
        startSample: dur,
        durationSamples: gap,
        gainDb: 0,
      },
      {
        id: "c2",
        sourceRef: { kind: "cache", path: wavVoice, hash: "vv", voiceUnitId: 1 },
        trackId: "voice",
        startSample: dur + gap,
        durationSamples: dur,
        gainDb: 0,
      },
      {
        id: "c3",
        sourceRef: { kind: "file", path: wavBed0 },
        trackId: "bed-0",
        startSample: 0,
        durationSamples: spanSamples,
        gainDb: 0,
      },
      {
        id: "c4",
        sourceRef: { kind: "file", path: wavBed1 },
        trackId: "bed-1",
        startSample: 0,
        durationSamples: spanSamples,
        gainDb: 0,
      },
    ],
    ducking: [
      {
        bedTrackId: "bed-0",
        duckUnderTrackId: "voice",
        reductionDb: r0,
        preset: "speech-v1",
      },
      {
        bedTrackId: "bed-1",
        duckUnderTrackId: "voice",
        reductionDb: r1,
        preset: "speech-v1",
      },
    ],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav"] },
  };
}

// ---------------------------------------------------------------------------
// Golden: DUR -- 2-bed render duration within +-100 samples of voice span
// ---------------------------------------------------------------------------

describe("2-bed render duration", () => {
  it(
    "2-bed mono render: ffprobe duration is within +-100 samples of the voice span",
    async () => {
      const gap = Math.round(GAP_SEC * SR);
      const spanSamples = durVoice + gap + durVoice;

      const ir = build2BedIR({ voiceDurationSamples: durVoice, gapSamples: gap });
      const outPath = join(tmpDir, "out_2bed_dur.wav");
      const result = await runFfmpeg(compileIR(ir, outPath));
      expect(result.exitCode, `ffmpeg failed:\n${result.stderr.slice(-500)}`).toBe(0);

      const actual = await probeSamples(outPath);
      console.log(`[2bed-dur] actual=${actual} span=${spanSamples}`);

      expect(
        Math.abs(actual - spanSamples),
        `Duration ${actual} differs from span ${spanSamples} by more than 100 samples`,
      ).toBeLessThanOrEqual(100);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Golden: DUCK -- both beds duck >=6 dB, measured from the REAL compileIR output
//
// Strategy:
//   1. Run compileIR(<2-bed IR>) -> ffmpeg -> full_mix.wav
//   2. Apply per-band 4th-order Butterworth to the MIX output to isolate each bed:
//      - bed-0 band: 4000-6000 Hz  (bed-0 is at 5 kHz, voice is <=2 kHz)
//      - bed-1 band: 7500-11000 Hz (bed-1 is at 9 kHz, voice is <=2 kHz)
//   3. Measure RMS in the voice-active window vs the gap window for each band.
//   4. Assert depth >= 6 dB for both.
//
// Isolation guarantee:
//   SyntheticAdapter generates pure sinusoids at 200-2000 Hz (no harmonics).
//   Two cascaded 2nd-order highpasses at 4000 Hz reject 2000 Hz by >24 dB --
//   voice leakage is negligible relative to the bed signal in each band.
//
// Failure modes caught:
//   - Silenced bed: gap RMS = -inf -> depth = 0 dB < 6 dB -> FAIL
//   - asplit=2 instead of =3: one key copy is exhausted after bed-0; bed-1 has
//     no sidechain key and never ducks -> bed-1 depth = 0 dB < 6 dB -> FAIL
//   - Shared-duck (both beds wired to one sidechaincompress): the un-keyed bed
//     passes through uncompressed during voice -> depth = 0 dB -> FAIL
// ---------------------------------------------------------------------------

describe("2-bed independent ducking from real compileIR output", () => {
  it(
    "bed-0 and bed-1 each duck >=6 dB during voice span vs gap, " +
      "measured via per-band RMS from the actual compileIR() output WAV",
    async () => {
      const gap = Math.round(GAP_SEC * SR);

      const ir = build2BedIR({ voiceDurationSamples: durVoice, gapSamples: gap });
      const mixPath = join(tmpDir, "out_2bed_duck.wav");
      const result = await runFfmpeg(compileIR(ir, mixPath));
      expect(result.exitCode, `ffmpeg failed:\n${result.stderr.slice(-500)}`).toBe(0);

      // Middle 60% of first voice span (skip attack transient at start)
      const voiceStart = Math.round(durVoice * 0.2);
      const voiceEnd = Math.round(durVoice * 0.8);

      // Middle 50% of gap (skip compressor release at gap entry)
      const gapStart = durVoice + Math.round(gap * 0.4);
      const gapEnd = durVoice + Math.round(gap * 0.9);

      // bed-0 band: 4000-6000 Hz (bed-0 is at 5000 Hz)
      const BED0_LO = 4000;
      const BED0_HI = 6000;
      // bed-1 band: 7500-11000 Hz (bed-1 is at 9000 Hz)
      const BED1_LO = 7500;
      const BED1_HI = 11000;

      const [bed0Voice, bed0Gap, bed1Voice, bed1Gap] = await Promise.all([
        probeRmsDbBandpass(mixPath, voiceStart, voiceEnd, BED0_LO, BED0_HI),
        probeRmsDbBandpass(mixPath, gapStart, gapEnd, BED0_LO, BED0_HI),
        probeRmsDbBandpass(mixPath, voiceStart, voiceEnd, BED1_LO, BED1_HI),
        probeRmsDbBandpass(mixPath, gapStart, gapEnd, BED1_LO, BED1_HI),
      ]);

      console.log(
        `[2bed-duck] bed-0: voice=${bed0Voice.toFixed(2)} gap=${bed0Gap.toFixed(2)} ` +
          `depth=${(bed0Gap - bed0Voice).toFixed(2)} dB`,
      );
      console.log(
        `[2bed-duck] bed-1: voice=${bed1Voice.toFixed(2)} gap=${bed1Gap.toFixed(2)} ` +
          `depth=${(bed1Gap - bed1Voice).toFixed(2)} dB`,
      );

      const depth0 = bed0Gap - bed0Voice;
      const depth1 = bed1Gap - bed1Voice;

      expect(
        depth0,
        `Bed-0 ducking depth ${depth0.toFixed(2)} dB < 6 dB ` +
          `(voice=${bed0Voice.toFixed(2)}, gap=${bed0Gap.toFixed(2)})`,
      ).toBeGreaterThanOrEqual(6);

      expect(
        depth1,
        `Bed-1 ducking depth ${depth1.toFixed(2)} dB < 6 dB ` +
          `(voice=${bed1Voice.toFixed(2)}, gap=${bed1Gap.toFixed(2)})`,
      ).toBeGreaterThanOrEqual(6);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Golden: REG -- single-bed render still works (regression)
// ---------------------------------------------------------------------------

describe("1-bed regression with real ffmpeg", () => {
  it(
    "1-bed render: exit code 0, non-empty output",
    async () => {
      const gap = Math.round(GAP_SEC * SR);

      const ir: IR = {
        schemaVersion: 3,
        sampleRate: SR,
        channels: 1,
        episode: { title: "1-Bed Regression" },
        tracks: [{ trackId: "voice" }, { trackId: "bed-0" }],
        clips: [
          {
            id: "c0",
            sourceRef: { kind: "cache", path: wavVoice, hash: "vv", voiceUnitId: 0 },
            trackId: "voice",
            startSample: 0,
            durationSamples: durVoice,
            gainDb: 0,
          },
          {
            id: "c1",
            sourceRef: { kind: "silence" },
            trackId: "voice",
            startSample: durVoice,
            durationSamples: gap,
            gainDb: 0,
          },
          {
            id: "c2",
            sourceRef: { kind: "file", path: wavBed0 },
            trackId: "bed-0",
            startSample: 0,
            durationSamples: durVoice + gap,
            gainDb: 0,
          },
        ],
        ducking: [
          {
            bedTrackId: "bed-0",
            duckUnderTrackId: "voice",
            reductionDb: -12,
            preset: "speech-v1",
          },
        ],
        chapters: [],
        loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
        render: { outputs: ["wav"] },
      };

      const outPath = join(tmpDir, "out_1bed_regression.wav");
      const result = await runFfmpeg(compileIR(ir, outPath));
      expect(result.exitCode, `ffmpeg failed:\n${result.stderr.slice(-500)}`).toBe(0);

      const actual = await probeSamples(outPath);
      expect(actual).toBeGreaterThan(0);
    },
    120_000,
  );
});
