// Golden test: multi-chunk Voice rendered via real ffmpeg.
// Verifies that splitting one Voice into N chunks produces the correct total audio duration.
// Tolerance: ±10 samples at 48kHz (rounding from probe).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SoundstageElement } from "../../src/jsx-runtime/index.js";
import type { ChunkResult } from "../../src/ir/phase-a.js";
import { phaseB } from "../../src/ir/phase-b.js";
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg } from "../../src/compiler/run.js";
import { applyLoudnorm } from "../../src/compiler/loudnorm.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Generate real WAV fixtures via ffmpeg
// ---------------------------------------------------------------------------

/** Generate a deterministic sine-tone WAV of exact `samples` samples at 48kHz. */
async function generateWav(outPath: string, samples: number): Promise<void> {
  const durationSec = samples / 48000;
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=440:duration=${durationSec}:sample_rate=48000`,
    "-c:a", "pcm_s16le",
    "-ac", "1",
    outPath,
  ]);
}

/** Probe the number of samples in a WAV file (exact frame count via nb_read_frames). */
async function probeSamples(wavPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=nb_read_frames,sample_rate,duration",
    "-count_packets",
    "-of", "default=noprint_wrappers=1",
    wavPath,
  ], { encoding: "utf8" });

  // Try exact frame count first.
  const framesMatch = stdout.match(/^nb_read_frames=(\d+)$/m);
  if (framesMatch) {
    return parseInt(framesMatch[1]!, 10);
  }
  // Fallback: duration × sample_rate.
  const durationMatch = stdout.match(/^duration=([0-9.]+)$/m);
  const sampleRateMatch = stdout.match(/^sample_rate=(\d+)$/m);
  if (durationMatch && sampleRateMatch) {
    const dur = parseFloat(durationMatch[1]!);
    const sr = parseInt(sampleRateMatch[1]!, 10);
    return Math.round(dur * sr);
  }
  throw new Error(`Cannot probe samples from ${wavPath}:\n${stdout}`);
}

// ---------------------------------------------------------------------------
// Helpers: build fabricated multi-chunk Voice IR node
// ---------------------------------------------------------------------------

function makeChunk(wavPath: string, durationSamples: number, idx: number): ChunkResult {
  return {
    wavPath,
    durationSamples,
    sampleRate: 48000,
    hash: `deadbeef${idx.toString(16).padStart(2, "0")}`,
    hit: false,
    originalText: `chunk ${idx} text.`,
  };
}

function multiChunkVoiceNode(chunks: ChunkResult[]): SoundstageElement {
  return {
    type: "Voice",
    props: { voice: "host", voiceUnitId: 0, chunks },
    children: ["..."],
  };
}

function episodeNode(children: SoundstageElement[]): SoundstageElement {
  return {
    type: "Episode",
    props: { title: "Chunk Seam Test", sampleRate: 48000 },
    children,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

// Chunk durations chosen to be clearly distinguishable and large enough for
// ffmpeg to handle (> 1024 samples each).
const CHUNK_DURATIONS = [48000, 72000, 60000]; // 1s, 1.5s, 1.25s at 48kHz
const TOTAL_SAMPLES = CHUNK_DURATIONS.reduce((a, b) => a + b, 0); // 180000 = 3.75s

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-chunk-seam-"));
  await mkdir(join(tmpDir, "chunks"), { recursive: true });

  // Generate three distinct WAV files — one per chunk.
  for (let i = 0; i < CHUNK_DURATIONS.length; i++) {
    await generateWav(
      join(tmpDir, "chunks", `chunk${i}.wav`),
      CHUNK_DURATIONS[i]!,
    );
  }
}, 60_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("chunk seam: 3-chunk Voice → correct total duration after ffmpeg render", () => {
  it("rendered WAV total samples ≈ sum of 3 chunk durations ±10 samples", async () => {
    const chunks: ChunkResult[] = CHUNK_DURATIONS.map((dur, i) =>
      makeChunk(join(tmpDir, "chunks", `chunk${i}.wav`), dur, i),
    );

    const voice = multiChunkVoiceNode(chunks);
    const ir = phaseB(episodeNode([voice]));
    ir.render.outputs = ["wav"];

    const wavOut = join(tmpDir, "output.wav");
    const mixPath = join(tmpDir, "mix.f32.wav");

    const compiled = compileIR(ir, mixPath);
    const mixResult = await runFfmpeg(compiled);
    expect(mixResult.exitCode).toBe(0);

    await applyLoudnorm(mixPath, ir.loudness, ir.sampleRate, wavOut);

    const actualSamples = await probeSamples(wavOut);

    // Allow ±10 samples for ffmpeg loudnorm rounding.
    expect(actualSamples).toBeGreaterThanOrEqual(TOTAL_SAMPLES - 10);
    expect(actualSamples).toBeLessThanOrEqual(TOTAL_SAMPLES + 10);
  }, 60_000);

  it("all 3 chunks appear in IR as separate voice ClipIRs with contiguous positions", () => {
    const chunks: ChunkResult[] = CHUNK_DURATIONS.map((dur, i) =>
      makeChunk(join(tmpDir, "chunks", `chunk${i}.wav`), dur, i),
    );

    const voice = multiChunkVoiceNode(chunks);
    const ir = phaseB(episodeNode([voice]));

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips).toHaveLength(3);

    expect(voiceClips[0]!.startSample).toBe(0);
    expect(voiceClips[1]!.startSample).toBe(CHUNK_DURATIONS[0]);
    expect(voiceClips[2]!.startSample).toBe(CHUNK_DURATIONS[0]! + CHUNK_DURATIONS[1]!);
  });

  it("all 3 ClipIRs share voiceUnitId=0", () => {
    const chunks: ChunkResult[] = CHUNK_DURATIONS.map((dur, i) =>
      makeChunk(join(tmpDir, "chunks", `chunk${i}.wav`), dur, i),
    );

    const voice = multiChunkVoiceNode(chunks);
    const ir = phaseB(episodeNode([voice]));

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    for (const clip of voiceClips) {
      expect(clip.sourceRef.kind).toBe("cache");
      if (clip.sourceRef.kind === "cache") {
        expect(clip.sourceRef.voiceUnitId).toBe(0);
      }
    }
  });
});
