// Golden tests for Task 9: Two-Pass Loudnorm + Bit-Exact Encode (WAV + mp3).
//
// footgun: loudnorm dynamic fallback (non-linear path) produces non-deterministic output
// footgun: implicit -ar causes loudnorm to resample to wrong rate
// footgun: missing -bitexact breaks byte-identical WAV master guarantee
// footgun: applying loudnorm per-segment (not on full mix) causes level drift

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg } from "../../src/compiler/run.js";
import { applyLoudnorm, measureLoudnorm, buildPass2Argv } from "../../src/compiler/loudnorm.js";
import { encodeMp3, buildMp3Argv } from "../../src/compiler/encode.js";
import { getFfmpegVersion } from "../../src/compiler/run.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import type { IR } from "../../src/ir/phase-b.js";

const execFileAsync = promisify(execFile);
const SR = 48000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Probe integrated loudness (I) and true peak (TP) via ebur128 filter. */
async function probeLoudness(path: string): Promise<{ I: number; TP: number }> {
  // ebur128=peak=peak emits per-frame lines and a Summary block to stderr.
  // Summary block format (ffmpeg 5+):
  //
  //   Summary:
  //     Integrated loudness:
  //       I:         -16.0 LUFS
  //       ...
  //     True peak:
  //       Peak:       -1.6 dBFS
  //
  // We parse only from the "Summary:" block to avoid per-frame "I:" values.
  let stderr = "";
  try {
    const result = await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-f", "lavfi",
        "-i", `amovie=${path.replace(/\\/g, "/")},ebur128=peak=true`,
        "-f", "null",
        "-",
      ],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    ) as { stderr: string };
    stderr = result.stderr;
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "stderr" in err &&
      typeof (err as { stderr: unknown }).stderr === "string"
    ) {
      stderr = (err as { stderr: string }).stderr;
    } else {
      throw err;
    }
  }

  // Extract only the Summary block to avoid matching per-frame "I:" lines.
  const summaryIdx = stderr.lastIndexOf("Summary:");
  if (summaryIdx === -1) {
    throw new Error(`ebur128: could not find Summary block in stderr.\n${stderr.slice(-3000)}`);
  }
  const summary = stderr.slice(summaryIdx);

  // Parse integrated loudness: "    I:         -16.0 LUFS"
  const iMatch = summary.match(/\bI:\s*([-\d.]+)\s*LUFS/);
  // Parse true peak: "      Peak:      -12.2 dBFS"
  const tpMatch = summary.match(/Peak:\s*([-\d.]+)\s*dBFS/);

  if (!iMatch) {
    throw new Error(`ebur128: could not parse integrated loudness from stderr.\n${stderr.slice(-3000)}`);
  }
  if (!tpMatch) {
    throw new Error(`ebur128: could not parse true peak from stderr.\n${stderr.slice(-3000)}`);
  }

  return {
    I: parseFloat(iMatch[1]!),
    TP: parseFloat(tpMatch[1]!),
  };
}

/** Run ffprobe and return duration in seconds. */
async function probeDurationSec(path: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { encoding: "utf8" },
  ) as { stdout: string };

  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(`ffprobe: invalid duration "${stdout.trim()}" for ${path}`);
  }
  return d;
}

/** Probe audio codec name from ffprobe. */
async function probeCodecName(path: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_name",
      "-of", "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { encoding: "utf8" },
  ) as { stdout: string };
  return stdout.trim();
}

/** Probe sample_fmt from ffprobe. */
async function probeSampleFmt(path: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=sample_fmt",
      "-of", "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { encoding: "utf8" },
  ) as { stdout: string };
  return stdout.trim();
}

/** SHA-256 hex digest of a file. */
async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

/** Build a minimal IR with a single voice clip. */
function buildIR(wavPath: string, durationSamples: number): IR {
  return {
    schemaVersion: 2,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Loudnorm Golden Test" },
    tracks: [{ trackId: "voice" }],
    clips: [
      {
        id: "c0",
        sourceRef: { kind: "cache", path: wavPath },
        trackId: "voice",
        startSample: 0,
        durationSamples,
        gainDb: 0,
      },
    ],
    ducking: [],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav", "mp3"] },
  };
}

/**
 * Run the full 3-pass pipeline on a given IR:
 *   1. Mix pass → mix.f32.wav
 *   2. Loudnorm measure + apply → master.wav  (if "wav" in render.outputs)
 *   3. mp3 encode → episode.mp3               (if "mp3" in render.outputs)
 * Returns paths to all output files + measured loudnorm values.
 */
async function renderFullPipeline(
  ir: IR,
  outDir: string,
): Promise<{
  mixPath: string;
  masterWavPath: string;
  mp3Path: string | null;
  measured: Awaited<ReturnType<typeof measureLoudnorm>>;
}> {
  const mixPath = join(outDir, "mix.f32.wav");
  const masterWavPath = join(outDir, "master.wav");

  // Pass 1: mix
  const compiled = compileIR(ir, mixPath);
  const mixResult = await runFfmpeg(compiled);
  if (mixResult.exitCode !== 0) {
    throw new Error(`Mix pass failed (exit ${mixResult.exitCode}):\n${mixResult.stderr}`);
  }

  // Pass 2+3: loudnorm (measure + apply) — only if "wav" is in render.outputs
  const { measured, wavPath } = await applyLoudnorm(
    mixPath,
    ir.loudness,
    ir.sampleRate,
    masterWavPath,
  );
  void wavPath; // returned for downstream use; masterWavPath is the same value

  // Pass 4: mp3 encode — only if "mp3" is in render.outputs
  let mp3Path: string | null = null;
  if (ir.render.outputs.includes("mp3")) {
    mp3Path = await encodeMp3(masterWavPath, join(outDir, "episode.mp3"));
  }

  return { mixPath, masterWavPath, mp3Path, measured };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let cacheDir: string;
let wavA: string;
let durA: number; // samples at 48kHz

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-loudnorm-"));
  cacheDir = join(tmpDir, "cache");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cacheDir, { recursive: true });

  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDir);

  const res = await cache.get({ text: "loudnorm golden test voice segment alpha", voice: "host", sampleRate: 24000 });
  wavA = res.wavPath;
  durA = res.durationSamples * 2; // 24k→48k
}, 60_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC: integrated loudness ≈ -16 LUFS, true peak ≤ -1.5 dBTP
// ---------------------------------------------------------------------------

describe("loudnorm golden: output measures within target bounds", () => {
  it("master.wav has I within ±1 LUFS of -16 and TP ≤ -1.5 dBTP", async () => {
    const outDir = join(tmpDir, "loudness-check");
    await (await import("node:fs/promises")).mkdir(outDir, { recursive: true });

    const ir = buildIR(wavA, durA);
    const { masterWavPath } = await renderFullPipeline(ir, outDir);

    const { I, TP } = await probeLoudness(masterWavPath);

    // Report measured values (visible in test output on failure)
    expect(I, `measured I=${I} LUFS should be within ±1 of -16`).toBeGreaterThanOrEqual(-17);
    expect(I, `measured I=${I} LUFS should be within ±1 of -16`).toBeLessThanOrEqual(-15);
    expect(TP, `measured TP=${TP} dBTP should be ≤ -1.5`).toBeLessThanOrEqual(-1.5);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// AC: linear=true is present in pass-2 argv
// ---------------------------------------------------------------------------

describe("loudnorm: linear=true is in pass-2 argv", () => {
  it("buildPass2Argv includes linear=true", async () => {
    // We do a measure-only pass to get real measured values (not stubs)
    const outDir = join(tmpDir, "linear-check");
    await (await import("node:fs/promises")).mkdir(outDir, { recursive: true });

    const ir = buildIR(wavA, durA);
    const mixPath = join(outDir, "mix.f32.wav");
    const compiled = compileIR(ir, mixPath);
    const mixResult = await runFfmpeg(compiled);
    if (mixResult.exitCode !== 0) throw new Error(`Mix failed: ${mixResult.stderr}`);

    const measured = await measureLoudnorm(mixPath, ir.loudness);
    const argv = buildPass2Argv(mixPath, measured, ir.loudness, ir.sampleRate, join(outDir, "master.wav"));

    // The -af filter string must contain linear=true
    const afIdx = argv.indexOf("-af");
    expect(afIdx, "argv must have -af flag").toBeGreaterThanOrEqual(0);
    const filterStr = argv[afIdx + 1] ?? "";
    expect(filterStr).toContain("linear=true");
    // All 5 measured params must be embedded in the filter string
    expect(filterStr).toContain("measured_I=");
    expect(filterStr).toContain("measured_TP=");
    expect(filterStr).toContain("measured_LRA=");
    expect(filterStr).toContain("measured_thresh=");
    expect(filterStr).toContain("offset=");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// AC: -ar is explicitly set in pass-2 argv
// ---------------------------------------------------------------------------

describe("loudnorm: -ar is explicitly set in pass-2 argv", () => {
  it("buildPass2Argv includes -ar 48000", async () => {
    const outDir = join(tmpDir, "ar-check");
    await (await import("node:fs/promises")).mkdir(outDir, { recursive: true });

    const ir = buildIR(wavA, durA);
    const mixPath = join(outDir, "mix.f32.wav");
    const compiled = compileIR(ir, mixPath);
    const mixResult = await runFfmpeg(compiled);
    if (mixResult.exitCode !== 0) throw new Error(`Mix failed: ${mixResult.stderr}`);

    const measured = await measureLoudnorm(mixPath, ir.loudness);
    const argv = buildPass2Argv(mixPath, measured, ir.loudness, ir.sampleRate, join(outDir, "master.wav"));

    const arIdx = argv.indexOf("-ar");
    expect(arIdx, "argv must have -ar flag").toBeGreaterThanOrEqual(0);
    expect(argv[arIdx + 1]).toBe("48000");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// AC: -bitexact is in pass-2 WAV argv AND mp3 argv
// ---------------------------------------------------------------------------

describe("loudnorm + encode: -bitexact present in both invocations", () => {
  it("buildPass2Argv contains -bitexact", async () => {
    const outDir = join(tmpDir, "bitexact-wav-check");
    await (await import("node:fs/promises")).mkdir(outDir, { recursive: true });

    const ir = buildIR(wavA, durA);
    const mixPath = join(outDir, "mix.f32.wav");
    const compiled = compileIR(ir, mixPath);
    const mixResult = await runFfmpeg(compiled);
    if (mixResult.exitCode !== 0) throw new Error(`Mix failed: ${mixResult.stderr}`);

    const measured = await measureLoudnorm(mixPath, ir.loudness);
    const argv = buildPass2Argv(mixPath, measured, ir.loudness, ir.sampleRate, join(outDir, "master.wav"));

    // -bitexact appears twice: before -i and before the output path
    const bitexactOccurrences = argv.filter(a => a === "-bitexact").length;
    expect(bitexactOccurrences, "-bitexact must appear (at least) twice in pass-2 argv").toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("buildMp3Argv contains -bitexact", () => {
    const argv = buildMp3Argv("/tmp/master.wav", "/tmp/episode.mp3");
    expect(argv).toContain("-bitexact");
  });
});

// ---------------------------------------------------------------------------
// AC: loudnorm is NOT embedded inside the mix filter graph (code structure)
// ---------------------------------------------------------------------------

describe("loudnorm: not embedded in filter graph", () => {
  it("compileIR filter script does not contain 'loudnorm'", () => {
    const ir = buildIR(wavA, durA);
    // Use a dummy outPath (the mix pass doesn't run here — we just compile)
    const compiled = compileIR(ir, "/tmp/mix.f32.wav");
    expect(compiled.filterScript).not.toContain("loudnorm");
  });
});

// ---------------------------------------------------------------------------
// AC: byte-identical WAV master from same cache (warm-cache determinism)
// ---------------------------------------------------------------------------

describe("determinism: byte-identical WAV master from warm cache", () => {
  it("two renders of the same IR with warm cache produce identical master.wav", async () => {
    const outDir1 = join(tmpDir, "determ-render-1");
    const outDir2 = join(tmpDir, "determ-render-2");
    await Promise.all([
      (await import("node:fs/promises")).mkdir(outDir1, { recursive: true }),
      (await import("node:fs/promises")).mkdir(outDir2, { recursive: true }),
    ]);

    const ir = buildIR(wavA, durA);

    // First render — populates the mix, loudnorm pass runs
    const { masterWavPath: wav1 } = await renderFullPipeline(ir, outDir1);

    // Second render — same IR, same wavA (cache is already warm from beforeAll)
    const { masterWavPath: wav2 } = await renderFullPipeline(ir, outDir2);

    const hash1 = await sha256File(wav1);
    const hash2 = await sha256File(wav2);

    expect(hash1, "WAV masters must be byte-identical").toBe(hash2);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// AC: WAV master is pinned to pcm_s16le (sample_fmt = s16)
// ---------------------------------------------------------------------------

describe("WAV master codec: pinned to pcm_s16le", () => {
  it("master.wav sample_fmt is s16 (pcm_s16le)", async () => {
    const outDir = join(tmpDir, "codec-pin-check");
    await (await import("node:fs/promises")).mkdir(outDir, { recursive: true });

    const ir = buildIR(wavA, durA);
    const { masterWavPath } = await renderFullPipeline(ir, outDir);

    const sampleFmt = await probeSampleFmt(masterWavPath);
    expect(sampleFmt, "master.wav must be pcm_s16le (s16)").toBe("s16");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// AC: ffmpegVersion in rendered IR matches ffmpeg -version
// ---------------------------------------------------------------------------

describe("ffmpegVersion detection", () => {
  it("getFfmpegVersion matches ffmpeg -version output", async () => {
    const detected = await getFfmpegVersion();
    const { stdout } = await execFileAsync("ffmpeg", ["-version"], { encoding: "utf8" }) as { stdout: string };
    const firstLine = stdout.split("\n")[0]?.trim() ?? "";
    const match = firstLine.match(/ffmpeg version (\S+)/);
    const expected = match?.[1] ?? firstLine;
    expect(detected).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// AC: episode.mp3 is produced, valid mp3, duration within ±1s of master.wav
// ---------------------------------------------------------------------------

describe("mp3 encode golden: valid mp3 with correct duration", () => {
  it("episode.mp3 is a valid mp3 and duration is within ±1s of master.wav", async () => {
    const outDir = join(tmpDir, "mp3-check");
    await (await import("node:fs/promises")).mkdir(outDir, { recursive: true });

    const ir = buildIR(wavA, durA);
    const { masterWavPath, mp3Path } = await renderFullPipeline(ir, outDir);
    if (!mp3Path) throw new Error("mp3 not produced — check render.outputs");

    // Verify codec is mp3
    const codec = await probeCodecName(mp3Path);
    expect(codec).toBe("mp3");

    // Duration within ±1s
    const wavDur = await probeDurationSec(masterWavPath);
    const mp3Dur = await probeDurationSec(mp3Path);
    expect(Math.abs(mp3Dur - wavDur)).toBeLessThanOrEqual(1);
  }, 60_000);
});
