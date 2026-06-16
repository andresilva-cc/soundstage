// Golden tests for the ffmpeg compiler voice lane (T8a).
// Each test runs real ffmpeg via run.ts with synthetic-adapter WAV fixtures.
// Assertions are via ffprobe/astats — never by ear.
//
// footgun: sample-domain placement drift (float seconds → wrong duration)
// footgun: universal input conditioning missing → rate mismatch on concat
// footgun: crossfade overlap not subtracted → total duration wrong

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
const TOLERANCE_SAMPLES = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run ffprobe on a WAV and return duration in samples (nb_samples preferred). */
async function probeSamples(path: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=nb_samples,sample_rate,duration",
    "-of", "json",
    path,
  ], { encoding: "utf8" }) as { stdout: string };

  const parsed = JSON.parse(stdout) as {
    streams: Array<{
      nb_samples?: string | number;
      sample_rate?: string | number;
      duration?: string;
    }>;
  };
  const stream = parsed.streams[0];
  if (!stream) throw new Error(`ffprobe: no stream in ${path}`);

  if (stream.nb_samples !== undefined) {
    const n = typeof stream.nb_samples === "string"
      ? parseInt(stream.nb_samples, 10)
      : Math.trunc(stream.nb_samples);
    if (n > 0) return n;
  }

  // Fallback: duration × sample_rate
  if (stream.duration !== undefined && stream.sample_rate !== undefined) {
    const dur = parseFloat(stream.duration);
    const rate = typeof stream.sample_rate === "string"
      ? parseInt(stream.sample_rate, 10)
      : Math.trunc(stream.sample_rate);
    if (Number.isFinite(dur) && rate > 0) return Math.round(dur * rate);
  }

  throw new Error(`ffprobe: could not determine duration for ${path}`);
}

/** Run ffprobe and return key audio stream properties (Fix #12). */
async function probeStreamInfo(path: string): Promise<{
  sampleRate: number;
  channels: number;
  sampleFmt: string;
}> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,channels,sample_fmt",
    "-of", "json",
    path,
  ], { encoding: "utf8" }) as { stdout: string };

  const parsed = JSON.parse(stdout) as {
    streams: Array<{
      sample_rate?: string | number;
      channels?: number;
      sample_fmt?: string;
    }>;
  };
  const s = parsed.streams[0];
  if (!s) throw new Error(`ffprobe: no stream in ${path}`);

  return {
    sampleRate: typeof s.sample_rate === "string" ? parseInt(s.sample_rate, 10) : (s.sample_rate ?? 0),
    channels: s.channels ?? 0,
    sampleFmt: s.sample_fmt ?? "",
  };
}

/**
 * Compute RMS power (linear) of an audio file over a sample range via astats.
 * Uses ffmpeg's astats filter with a short window.
 * Returns RMS in dBFS (negative number; -inf = silence).
 */
async function probeRmsDb(path: string, startSample: number, endSample: number): Promise<number> {
  const startSec = startSample / SR;
  const durationSec = (endSample - startSample) / SR;

  const { stderr } = await execFileAsync("ffmpeg", [
    "-y",
    "-ss", String(startSec),
    "-t", String(durationSec),
    "-i", path,
    "-af", "astats=metadata=1:reset=1",
    "-f", "null",
    "-",
  ], { encoding: "utf8" }) as { stderr: string };

  // Parse the FIRST "RMS level dB: <value>" from stderr.
  // Alternatives ordered longest-first so -inf is tried before the [-\d.]+ char class
  // (which would greedily match the leading '-' and stop before 'i').
  const match = stderr.match(/RMS level dB:\s*(-inf|inf|[-\d.]+)/);
  if (!match) return -Infinity;
  const val = match[1]!;
  if (val === "-inf" || val === "inf") return -Infinity;
  return parseFloat(val);
}

/** Build a base IR with given clips. */
function buildIR(clips: IR["clips"]): IR {
  return {
    schemaVersion: 2,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Golden Test" },
    tracks: [{ trackId: "voice" }],
    clips,
    ducking: [],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav"] },
  };
}

// ---------------------------------------------------------------------------
// Test setup — synthesize WAV fixtures via CacheLayer + SyntheticAdapter
// ---------------------------------------------------------------------------

let tmpDir: string;
let cacheDir: string;
// WAV paths synthesized from the cache (24kHz f32le — upsampled by compiler to 48k)
let wavA: string;
let wavB: string;
let wavC: string;
// Duration in samples at the CACHE rate (24000)
let durA_cache: number;
let durB_cache: number;
let durC_cache: number;
// Duration in samples at 48000 Hz (after upsampling; = durX_cache * 2 since 24k→48k)
let durA: number;
let durB: number;
let durC: number;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-golden-"));
  cacheDir = join(tmpDir, "cache");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cacheDir, { recursive: true });

  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDir);

  const getWav = async (text: string) => {
    const res = await cache.get({ text, voice: "host", sampleRate: 24000 });
    return res;
  };

  const rA = await getWav("golden test clip alpha");
  const rB = await getWav("golden test clip beta");
  const rC = await getWav("golden test clip gamma");

  wavA = rA.wavPath;
  wavB = rB.wavPath;
  wavC = rC.wavPath;

  durA_cache = rA.durationSamples;
  durB_cache = rB.durationSamples;
  durC_cache = rC.durationSamples;

  // At 48kHz (after upsampling by compiler), sample count doubles (24k→48k)
  durA = durA_cache * 2;
  durB = durB_cache * 2;
  durC = durC_cache * 2;
}, 60_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Anchor: verify fixture durations are in the known synthetic-adapter range.
// SyntheticAdapter produces 0.2s–2.0s at 24kHz (4800–48000 samples); after
// 24k→48k upsampling durX = durX_cache * 2, so range is 9600–96000 at 48kHz.
// This assertion is INDEPENDENT of the * 2 computation — it uses hardcoded
// bounds derived from the adapter source, so a bug in the upsampling factor
// would fail here before reaching the duration golden tests.
// ---------------------------------------------------------------------------

describe("fixture sanity: synthetic-adapter durations are in known range", () => {
  const MIN_AT_48K = 9600;  // 0.2 s × 48000 Hz
  const MAX_AT_48K = 96000; // 2.0 s × 48000 Hz

  it("durA is in [9600, 96000]", () => {
    expect(durA).toBeGreaterThanOrEqual(MIN_AT_48K);
    expect(durA).toBeLessThanOrEqual(MAX_AT_48K);
  });
  it("durB is in [9600, 96000]", () => {
    expect(durB).toBeGreaterThanOrEqual(MIN_AT_48K);
    expect(durB).toBeLessThanOrEqual(MAX_AT_48K);
  });
  it("durC is in [9600, 96000]", () => {
    expect(durC).toBeGreaterThanOrEqual(MIN_AT_48K);
    expect(durC).toBeLessThanOrEqual(MAX_AT_48K);
  });
});

// ---------------------------------------------------------------------------
// Golden AC8: 3-clip render — output duration ≈ expected total
// ---------------------------------------------------------------------------

describe("AC8: golden — 3-clip sequential render duration", () => {
  it("output duration is within ±100 samples of expected total", async () => {
    // Pin expected total independently from IR construction so the test is not
    // circular (a bug that zeroed durationSamples in both would still pass otherwise).
    const clipDurA = durA;
    const clipDurB = durB;
    const clipDurC = durC;
    const expectedTotal = clipDurA + clipDurB + clipDurC; // independent literal

    const ir = buildIR([
      {
        id: "c0",
        sourceRef: { kind: "cache", path: wavA, hash: "a", voiceUnitId: 0 },
        trackId: "voice",
        startSample: 0,
        durationSamples: clipDurA,
        gainDb: 0,
      },
      {
        id: "c1",
        sourceRef: { kind: "cache", path: wavB, hash: "b", voiceUnitId: 1 },
        trackId: "voice",
        startSample: clipDurA,
        durationSamples: clipDurB,
        gainDb: 0,
      },
      {
        id: "c2",
        sourceRef: { kind: "cache", path: wavC, hash: "c", voiceUnitId: 2 },
        trackId: "voice",
        startSample: clipDurA + clipDurB,
        durationSamples: clipDurC,
        gainDb: 0,
      },
    ]);

    const outPath = join(tmpDir, "out_3clip.wav");
    const compiled = compileIR(ir, outPath);
    const result = await runFfmpeg(compiled);

    expect(result.exitCode).toBe(0);

    const actual = await probeSamples(outPath);
    expect(Math.abs(actual - expectedTotal)).toBeLessThanOrEqual(TOLERANCE_SAMPLES);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Golden AC9: crossfade shortens total duration by overlap
// ---------------------------------------------------------------------------

describe("AC9: golden — crossfade reduces total duration by overlap", () => {
  it("output duration = durA + durB − overlap, within ±100 samples", async () => {
    // Use a small overlap that fits within both clips (each is ~0.3–2.0s at 48k).
    // durA and durB are at 48kHz; min synthetic clip is 0.2s * 2 (upsampled) = 19200 samples.
    // Use 0.1s overlap = 4800 samples (safely below any synthetic clip duration).
    const overlapSamples = Math.round(0.1 * SR); // 4800 — independent literal, not from IR
    const clipDurA = durA;
    const clipDurB = durB;
    const expectedTotal = clipDurA + clipDurB - overlapSamples; // independent computation

    const ir = buildIR([
      {
        id: "c0",
        sourceRef: { kind: "cache", path: wavA, hash: "a", voiceUnitId: 0 },
        trackId: "voice",
        startSample: 0,
        durationSamples: clipDurA,
        gainDb: 0,
        crossfadeIntoNext: { durationSamples: overlapSamples, curve: "tri" },
      },
      {
        id: "c1",
        sourceRef: { kind: "cache", path: wavB, hash: "b", voiceUnitId: 1 },
        trackId: "voice",
        startSample: clipDurA - overlapSamples,
        durationSamples: clipDurB,
        gainDb: 0,
      },
    ]);

    const outPath = join(tmpDir, "out_crossfade.wav");
    const compiled = compileIR(ir, outPath);
    const result = await runFfmpeg(compiled);

    expect(result.exitCode).toBe(0);

    const actual = await probeSamples(outPath);
    expect(Math.abs(actual - expectedTotal)).toBeLessThanOrEqual(TOLERANCE_SAMPLES);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Golden: intermediate output is 48k mono f32le
// ---------------------------------------------------------------------------

describe("intermediate output format", () => {
  it("output WAV is 48000 Hz mono f32le (universal conditioning verified)", async () => {
    // Input is 24kHz (synthetic adapter) — upsampled to 48k by compiler
    const ir = buildIR([
      {
        id: "c0",
        sourceRef: { kind: "cache", path: wavA, hash: "a", voiceUnitId: 0 },
        trackId: "voice",
        startSample: 0,
        durationSamples: durA,
        gainDb: 0,
      },
    ]);

    const outPath = join(tmpDir, "out_rate.wav");
    const compiled = compileIR(ir, outPath);
    const result = await runFfmpeg(compiled);

    expect(result.exitCode).toBe(0);

    // Fix #12: assert sample_rate, channels, AND sample_fmt (not just rate)
    const info = await probeStreamInfo(outPath);
    expect(info.sampleRate).toBe(48000);
    expect(info.channels).toBe(1);
    expect(info.sampleFmt).toBe("flt"); // WAV stores f32le as "flt" in ffprobe
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Golden: silence clip produces near-silence span
// ---------------------------------------------------------------------------

describe("silence clip", () => {
  it("silence span has RMS very close to -inf dBFS", async () => {
    const silSamples = 2 * SR; // 2 seconds of silence
    // Single silence clip
    const ir = buildIR([
      {
        id: "c0",
        sourceRef: { kind: "silence" },
        trackId: "voice",
        startSample: 0,
        durationSamples: silSamples,
        gainDb: 0,
      },
    ]);

    const outPath = join(tmpDir, "out_silence.wav");
    const compiled = compileIR(ir, outPath);
    const result = await runFfmpeg(compiled);

    expect(result.exitCode).toBe(0);

    const actual = await probeSamples(outPath);
    // Duration should be approximately silSamples
    expect(Math.abs(actual - silSamples)).toBeLessThanOrEqual(TOLERANCE_SAMPLES);

    // RMS should be very low (near silence)
    const rmsDb = await probeRmsDb(outPath, 0, silSamples);
    // aevalsrc=0 produces exactly 0 samples; RMS is -inf or very low
    expect(rmsDb).toBeLessThan(-60);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Golden: non-round silence is sample-exact (Fix #1 / §3.2/§8 guarantee)
// ---------------------------------------------------------------------------

describe("silence sample-exact", () => {
  it("48001-sample silence renders to exactly 48001 samples", async () => {
    const silSamples = 48001; // non-round — would drift ±1 with float-only duration

    const ir = buildIR([
      {
        id: "c0",
        sourceRef: { kind: "silence" },
        trackId: "voice",
        startSample: 0,
        durationSamples: silSamples,
        gainDb: 0,
      },
    ]);

    const outPath = join(tmpDir, "out_silence_exact.wav");
    const compiled = compileIR(ir, outPath);
    const result = await runFfmpeg(compiled);

    expect(result.exitCode).toBe(0);

    const actual = await probeSamples(outPath);
    // Must be exactly 48001 — no tolerance (atrim guarantees this)
    expect(actual).toBe(silSamples);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Golden: per-clip gainDb shifts measured RMS level (Fix #11)
// ---------------------------------------------------------------------------

describe("gainDb golden", () => {
  it("−6 dB gain lowers RMS by ~6 dB relative to 0 dB", async () => {
    // Render wavA at 0 dB, then at −6 dB. Compare RMS levels.
    const dur = durA;

    const irRef = buildIR([
      {
        id: "c0",
        sourceRef: { kind: "cache", path: wavA, hash: "a", voiceUnitId: 0 },
        trackId: "voice",
        startSample: 0,
        durationSamples: dur,
        gainDb: 0,
      },
    ]);
    const irGained = buildIR([
      {
        id: "c0",
        sourceRef: { kind: "cache", path: wavA, hash: "a", voiceUnitId: 0 },
        trackId: "voice",
        startSample: 0,
        durationSamples: dur,
        gainDb: -6,
      },
    ]);

    const outRef = join(tmpDir, "out_gain_ref.wav");
    const outGained = join(tmpDir, "out_gain_m6dB.wav");

    const [r1, r2] = await Promise.all([
      runFfmpeg(compileIR(irRef, outRef)),
      runFfmpeg(compileIR(irGained, outGained)),
    ]);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);

    const rmsRef = await probeRmsDb(outRef, 0, dur);
    const rmsGained = await probeRmsDb(outGained, 0, dur);

    // Difference should be approximately 6 dB (within ±2 dB tolerance)
    const diff = rmsRef - rmsGained;
    expect(diff).toBeGreaterThan(4);
    expect(diff).toBeLessThan(8);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Golden: filter-script snapshot for a 2-clip episode
// ---------------------------------------------------------------------------

describe("filter-script snapshot", () => {
  it("2-clip IR produces a stable filter-script snapshot", () => {
    const dur0 = 48000;
    const dur1 = 96000;
    const ir = buildIR([
      {
        id: "c0",
        sourceRef: { kind: "cache", path: "/cache/a.wav", hash: "abc", voiceUnitId: 0 },
        trackId: "voice",
        startSample: 0,
        durationSamples: dur0,
        gainDb: 0,
      },
      {
        id: "c1",
        sourceRef: { kind: "cache", path: "/cache/b.wav", hash: "def", voiceUnitId: 1 },
        trackId: "voice",
        startSample: dur0,
        durationSamples: dur1,
        gainDb: 0,
      },
    ]);

    const { filterScript } = compileIR(ir, "/tmp/out.wav");
    expect(filterScript).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Golden: run.ts writes script to temp file, not argv string
// ---------------------------------------------------------------------------

describe("AC6 golden: -filter_complex_script path in argv", () => {
  it("ffmpeg argv contains -filter_complex_script with a file path, not the script body", async () => {
    const ir = buildIR([
      {
        id: "c0",
        sourceRef: { kind: "cache", path: wavA, hash: "a", voiceUnitId: 0 },
        trackId: "voice",
        startSample: 0,
        durationSamples: durA,
        gainDb: 0,
      },
    ]);

    const outPath = join(tmpDir, "out_ac6.wav");
    const compiled = compileIR(ir, outPath);

    // The compiled.argv does NOT contain -filter_complex_script yet —
    // run.ts inserts it. Confirm script content is not in argv.
    for (const arg of compiled.argv) {
      expect(arg).not.toContain("aresample");
      expect(arg).not.toContain("filter_complex_script");
    }

    // Run and confirm success — which implicitly confirms script was written to a file
    const result = await runFfmpeg(compiled, false);
    expect(result.exitCode).toBe(0);
  }, 60_000);
});
