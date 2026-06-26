// Golden tests for Task 6: Visual Waveform + Interactive HTML Player.
//
// Golden test: waveform.png is a valid PNG file (magic bytes 89 50 4E 47).
// Error test: generateWaveform throws with "waveform generation failed" on ffmpeg failure.
//
// Uses the full pipeline (synthetic adapter + real ffmpeg) to produce an mp3,
// then calls generateWaveform to produce waveform.png and checks the result.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg } from "../../src/compiler/run.js";
import { applyLoudnorm } from "../../src/compiler/loudnorm.js";
import { encodeMp3 } from "../../src/compiler/encode.js";
import { generateWaveform } from "../../src/compiler/player.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import type { IR } from "../../src/ir/phase-b.js";

const SR = 48000;

// PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// ---------------------------------------------------------------------------
// Pipeline helper — produce episode.mp3 from a single-clip IR
// ---------------------------------------------------------------------------

async function buildMp3(outDir: string, cacheDir: string): Promise<string> {
  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDir, { noCache: false });

  // Synthetic adapter synthesizes at 24kHz; convert to master rate (48kHz) with * 2.
  const synthResult = await cache.get({
    text: "Hello, this is a waveform golden test.",
    voice: "af_heart",
    sampleRate: 24000,
  });
  // durationSamples from cache is at the native synthesis rate (24kHz).
  // Multiply by 2 to get the duration at 48kHz master rate.
  const dur48k = synthResult.durationSamples * 2;

  const ir: IR = {
    schemaVersion: 3,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Waveform Golden Test" },
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

  return mp3Path;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("waveform.png golden tests", () => {
  let tmpDir: string;
  let cacheDir: string;
  let outDir: string;
  let mp3Path: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "soundstage-player-golden-"));
    cacheDir = join(tmpDir, "cache");
    outDir = join(tmpDir, "out");
    await mkdir(cacheDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    mp3Path = await buildMp3(outDir, cacheDir);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("waveform.png has valid PNG magic bytes (89 50 4E 47)", async () => {
    const pngPath = await generateWaveform(mp3Path, outDir);
    const buf = await readFile(pngPath);
    // PNG signature: bytes 0–3 must be 89 50 4E 47
    expect(buf.slice(0, 4)).toEqual(PNG_MAGIC);
  });

  it("generateWaveform returns path ending in waveform.png", async () => {
    const pngPath = await generateWaveform(mp3Path, outDir);
    expect(pngPath).toMatch(/waveform\.png$/);
  });

  it("generateWaveform throws with 'waveform generation failed' on ffmpeg failure", async () => {
    // Provide a non-existent input — ffmpeg will exit non-zero
    await expect(
      generateWaveform("/nonexistent-input-that-does-not-exist.mp3", outDir),
    ).rejects.toThrow("waveform generation failed");
  });
});
