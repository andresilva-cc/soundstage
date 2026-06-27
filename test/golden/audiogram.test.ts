// Golden tests for Task 3: Audiogram / Social Video.
//
// Builds a real mp3 using the full synthetic-adapter pipeline, then calls
// generateAudiogram with real ffmpeg. Verifies the produced mp4 via ffprobe:
//   - correct dimensions per aspect preset
//   - h264 video stream + aac audio stream
//   - duration within ±2s of the source mp3
//   - non-zero file size
//
// NO byte-identity assertions — the mp4 is the lossy derived layer.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

// Detect drawtext support synchronously at module level. The standard Homebrew
// ffmpeg build does not include libfreetype, so drawtext is not available in
// all environments. Skip the real-ffmpeg golden tests when it's absent.
function hasDrawtext(): boolean {
  const result = spawnSync("ffmpeg", ["-filters"], { encoding: "utf8" });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  return output.includes("drawtext");
}
const drawtextAvailable = hasDrawtext();
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg } from "../../src/compiler/run.js";
import { applyLoudnorm } from "../../src/compiler/loudnorm.js";
import { encodeMp3 } from "../../src/compiler/encode.js";
import { generateAudiogram } from "../../src/compiler/audiogram.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import type { IR } from "../../src/ir/phase-b.js";

const execFileAsync = promisify(execFile);

const SR = 48000;

// ---------------------------------------------------------------------------
// ffprobe helpers
// ---------------------------------------------------------------------------

interface StreamInfo {
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeAllStreams {
  streams: StreamInfo[];
}

async function probeAllStreams(filePath: string): Promise<StreamInfo[]> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-show_streams", "-of", "json", filePath],
    { encoding: "utf8" },
  ) as { stdout: string };
  const parsed = JSON.parse(stdout) as FfprobeAllStreams;
  return parsed.streams ?? [];
}

async function probeDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=duration",
      "-of", "default=noprint_wrappers=1",
      filePath,
    ],
    { encoding: "utf8" },
  ) as { stdout: string };
  const match = stdout.match(/^duration=(.+)$/m);
  if (!match?.[1]) throw new Error(`ffprobe: no duration in ${filePath}`);
  return parseFloat(match[1]);
}

// ---------------------------------------------------------------------------
// Pipeline helper — produce mp3 from a single-Voice IR
// ---------------------------------------------------------------------------

async function buildMp3(outDir: string, cacheDir: string): Promise<{ mp3Path: string; ir: IR }> {
  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDir, { noCache: false });

  const synthResult = await cache.get({
    text: "Hello, this is an audiogram golden test. It has enough content to produce a real duration.",
    voice: "af_heart",
    sampleRate: 24000,
  });
  const dur48k = synthResult.durationSamples * 2;

  const ir: IR = {
    schemaVersion: 4,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Audiogram Golden Test" },
    tracks: [{ trackId: "voice" }],
    clips: [
      {
        id: "c0",
        sourceRef: { kind: "cache", path: synthResult.wavPath },
        trackId: "voice",
        startSample: 0,
        durationSamples: dur48k,
        gainDb: 0,
      },
    ],
    ducking: [],
    chapters: [{ title: "Intro", startSample: 0, endSample: dur48k }],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav", "mp3"] },
  };

  const mixPath = join(outDir, "mix.f32.wav");
  const masterWavPath = join(outDir, "master.wav");
  const mp3Path = join(outDir, "episode.mp3");

  const compiled = compileIR(ir, mixPath);
  const mixResult = await runFfmpeg(compiled);
  if (mixResult.exitCode !== 0) {
    throw new Error(`Mix pass failed (exit ${mixResult.exitCode}):\n${mixResult.stderr}`);
  }
  await applyLoudnorm(mixPath, ir.loudness, ir.sampleRate, masterWavPath);
  await encodeMp3(masterWavPath, mp3Path);

  return { mp3Path, ir };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let cacheDir: string;
let buildDir: string;
let mp3Path: string;
let ir: IR;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-audiogram-golden-"));
  cacheDir = join(tmpDir, "cache");
  buildDir = join(tmpDir, "build");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });

  const result = await buildMp3(buildDir, cacheDir);
  mp3Path = result.mp3Path;
  ir = result.ir;
}, 60_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Square aspect golden tests
// ---------------------------------------------------------------------------

describe.skipIf(!drawtextAvailable)("audiogram golden — square (1080×1080)", () => {
  let mp4Path: string;
  let streams: StreamInfo[];
  let mp4DurationSec: number;
  let mp3DurationSec: number;

  beforeAll(async () => {
    const outDir = join(tmpDir, "out-square");
    await mkdir(outDir, { recursive: true });
    mp4Path = await generateAudiogram(ir, mp3Path, { aspect: "square" }, outDir);
    streams = await probeAllStreams(mp4Path);
    mp4DurationSec = await probeDurationSec(mp4Path);
    mp3DurationSec = await probeDurationSec(mp3Path);
  }, 120_000);

  it("mp4 file has non-zero size", async () => {
    const info = await stat(mp4Path);
    expect(info.size).toBeGreaterThan(0);
  });

  it("mp4 has at least one video stream", () => {
    const videoStream = streams.find((s) => s.codec_type === "video");
    expect(videoStream).toBeDefined();
  });

  it("mp4 has at least one audio stream", () => {
    const audioStream = streams.find((s) => s.codec_type === "audio");
    expect(audioStream).toBeDefined();
  });

  it("video codec is h264", () => {
    const videoStream = streams.find((s) => s.codec_type === "video");
    expect(videoStream?.codec_name).toBe("h264");
  });

  it("audio codec is aac", () => {
    const audioStream = streams.find((s) => s.codec_type === "audio");
    expect(audioStream?.codec_name).toBe("aac");
  });

  it("dimensions are 1080×1080", () => {
    const videoStream = streams.find((s) => s.codec_type === "video");
    expect(videoStream?.width).toBe(1080);
    expect(videoStream?.height).toBe(1080);
  });

  it("mp4 duration is within ±2s of the mp3 duration", () => {
    expect(Math.abs(mp4DurationSec - mp3DurationSec)).toBeLessThanOrEqual(2);
  });

  it("returned path is <outDir>/<stem>-audiogram.mp4", () => {
    expect(mp4Path).toMatch(/episode-audiogram\.mp4$/);
  });
});

// ---------------------------------------------------------------------------
// Landscape aspect golden tests
// ---------------------------------------------------------------------------

describe.skipIf(!drawtextAvailable)("audiogram golden — landscape (1920×1080)", () => {
  let mp4Path: string;
  let streams: StreamInfo[];

  beforeAll(async () => {
    const outDir = join(tmpDir, "out-landscape");
    await mkdir(outDir, { recursive: true });
    mp4Path = await generateAudiogram(ir, mp3Path, { aspect: "landscape" }, outDir);
    streams = await probeAllStreams(mp4Path);
  }, 120_000);

  it("dimensions are 1920×1080", () => {
    const videoStream = streams.find((s) => s.codec_type === "video");
    expect(videoStream?.width).toBe(1920);
    expect(videoStream?.height).toBe(1080);
  });

  it("video codec is h264", () => {
    const videoStream = streams.find((s) => s.codec_type === "video");
    expect(videoStream?.codec_name).toBe("h264");
  });

  it("audio codec is aac", () => {
    const audioStream = streams.find((s) => s.codec_type === "audio");
    expect(audioStream?.codec_name).toBe("aac");
  });
});

// ---------------------------------------------------------------------------
// Vertical aspect golden tests
// ---------------------------------------------------------------------------

describe.skipIf(!drawtextAvailable)("audiogram golden — vertical (1080×1920)", () => {
  let mp4Path: string;
  let streams: StreamInfo[];

  beforeAll(async () => {
    const outDir = join(tmpDir, "out-vertical");
    await mkdir(outDir, { recursive: true });
    mp4Path = await generateAudiogram(ir, mp3Path, { aspect: "vertical" }, outDir);
    streams = await probeAllStreams(mp4Path);
  }, 120_000);

  it("dimensions are 1080×1920", () => {
    const videoStream = streams.find((s) => s.codec_type === "video");
    expect(videoStream?.width).toBe(1080);
    expect(videoStream?.height).toBe(1920);
  });

  it("video codec is h264", () => {
    const videoStream = streams.find((s) => s.codec_type === "video");
    expect(videoStream?.codec_name).toBe("h264");
  });

  it("audio codec is aac", () => {
    const audioStream = streams.find((s) => s.codec_type === "audio");
    expect(audioStream?.codec_name).toBe("aac");
  });
});

// ---------------------------------------------------------------------------
// generateAudiogram — error surfacing (real ffmpeg, bad input)
// ---------------------------------------------------------------------------

describe("audiogram golden — error surfacing", () => {
  it("generateAudiogram throws 'audiogram generation failed:' when ffmpeg fails", async () => {
    const outDir = join(tmpDir, "out-err");
    await mkdir(outDir, { recursive: true });
    // Pass a non-existent mp3 — ffmpeg will exit non-zero
    await expect(
      generateAudiogram(ir, "/nonexistent-does-not-exist.mp3", {}, outDir),
    ).rejects.toThrow("audiogram generation failed:");
  });
});
