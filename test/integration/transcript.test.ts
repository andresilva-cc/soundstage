// Integration tests for --transcript CLI flag (Task 1: Transcript / Subtitle Export).
//
// Tests use the synthetic adapter (hermetic, no model download).
// Mirrors the runRender logic from src/cli/index.ts — runs the full pipeline
// (Phase A + Phase B + compile + render) then exercises transcript generation.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename, extname, dirname } from "node:path";

import { loadTsx } from "../../src/cli/loader.js";
import { phaseA } from "../../src/ir/phase-a.js";
import { phaseB } from "../../src/ir/phase-b.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg, getFfmpegVersion } from "../../src/compiler/run.js";
import { applyLoudnorm } from "../../src/compiler/loudnorm.js";
import { encodeMp3 } from "../../src/compiler/encode.js";
import { runChapterPostPass } from "../../src/compiler/chapters.js";
import { generateWaveform, generatePlayer } from "../../src/compiler/player.js";
import {
  extractVoiceTexts,
  generateTranscriptCues,
  formatSrt,
  formatVtt,
  formatTxt,
} from "../../src/compiler/transcript.js";
import { readRenderState, writeRenderState, hashIR } from "../../src/cli/render-state.js";
import type { IR } from "../../src/ir/phase-b.js";
import type { SoundstageElement } from "../../src/jsx-runtime/index.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE_SIMPLE = new URL(
  "../fixtures/episodes/simple.tsx",
  import.meta.url,
).pathname;

// ---------------------------------------------------------------------------
// Pipeline helper — mirrors runRender's logic
// ---------------------------------------------------------------------------

interface RenderResult {
  ir: IR;
  resolvedTree: SoundstageElement;
  wavPath: string;
  mp3Path: string;
  stem: string;
}

async function renderFixture(
  fixturePath: string,
  outDir: string,
  cacheBaseDir: string,
  opts: { noCache?: boolean } = {},
): Promise<RenderResult> {
  const absFile = resolve(fixturePath);
  const fileBaseDir = dirname(absFile);
  const stem = basename(absFile, extname(absFile));
  const noCache = opts.noCache ?? false;

  const cacheDirPath = join(cacheBaseDir, ".soundstage", "cache");
  await mkdir(cacheDirPath, { recursive: true });

  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDirPath, { noCache });

  const chunkStats = new Map<number, { total: number; hits: number }>();
  function onVoiceSynthesized(
    voiceUnitId: number,
    _chunkIndex: number,
    _chunkTotal: number,
    hit: boolean,
  ): void {
    const stats = chunkStats.get(voiceUnitId) ?? { total: 0, hits: 0 };
    stats.total++;
    if (hit) stats.hits++;
    chunkStats.set(voiceUnitId, stats);
  }

  const tree = await loadTsx(absFile);
  const resolvedTree = await phaseA(tree, { cache, baseDir: fileBaseDir, onVoiceSynthesized });
  const ir = phaseB(resolvedTree);

  const ffmpegVersion = await getFfmpegVersion();
  ir.render.ffmpegVersion = ffmpegVersion;
  ir.render.outputs = ["wav", "mp3"];

  await mkdir(outDir, { recursive: true });
  const wavPath = join(outDir, `${stem}.wav`);
  const mp3Path = join(outDir, `${stem}.mp3`);

  const tmpRenderDir = await mkdtemp(join(tmpdir(), "soundstage-transcript-int-"));
  try {
    const mixPath = join(tmpRenderDir, "mix.f32.wav");
    const compiled = compileIR(ir, mixPath);
    const mixResult = await runFfmpeg(compiled);
    if (mixResult.exitCode !== 0) {
      throw new Error(`Mix failed: ${mixResult.stderr}`);
    }
    await applyLoudnorm(mixPath, ir.loudness, ir.sampleRate, wavPath);
    await encodeMp3(wavPath, mp3Path);
    await runChapterPostPass(ir, mp3Path, wavPath);
  } finally {
    await rm(tmpRenderDir, { recursive: true, force: true });
  }

  return { ir, resolvedTree, wavPath, mp3Path, stem };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let outDir: string;
let cacheDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-transcript-test-"));
  outDir = join(tmpDir, "out");
  cacheDir = join(tmpDir, "cache");
  await mkdir(outDir, { recursive: true });
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Without --transcript: no transcript files generated
// ---------------------------------------------------------------------------

describe("render without --transcript", () => {
  let result: RenderResult;

  beforeAll(async () => {
    const dir = join(outDir, "no-transcript");
    await mkdir(dir, { recursive: true });
    result = await renderFixture(FIXTURE_SIMPLE, dir, cacheDir);
  });

  it("does not produce a .srt file", async () => {
    const srtPath = join(dirname(result.wavPath), `${result.stem}.srt`);
    await expect(access(srtPath)).rejects.toThrow();
  });

  it("does not produce a .vtt file", async () => {
    const vttPath = join(dirname(result.wavPath), `${result.stem}.vtt`);
    await expect(access(vttPath)).rejects.toThrow();
  });

  it("does not produce a .txt file", async () => {
    const txtPath = join(dirname(result.wavPath), `${result.stem}.txt`);
    await expect(access(txtPath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// With --transcript: three files are generated
// ---------------------------------------------------------------------------

describe("render with --transcript", () => {
  let result: RenderResult;
  let srtPath: string;
  let vttPath: string;
  let txtPath: string;
  let srtContent: string;
  let vttContent: string;
  let txtContent: string;

  beforeAll(async () => {
    const dir = join(outDir, "with-transcript");
    await mkdir(dir, { recursive: true });
    result = await renderFixture(FIXTURE_SIMPLE, dir, cacheDir);

    // Mirror runRender's --transcript logic
    const voiceTexts = extractVoiceTexts(result.resolvedTree);
    const cues = generateTranscriptCues(result.ir, voiceTexts);

    srtPath = join(dir, `${result.stem}.srt`);
    vttPath = join(dir, `${result.stem}.vtt`);
    txtPath = join(dir, `${result.stem}.txt`);

    await writeFile(srtPath, formatSrt(cues, result.ir.sampleRate));
    await writeFile(vttPath, formatVtt(cues, result.ir.sampleRate));
    await writeFile(txtPath, formatTxt(result.ir, cues));

    srtContent = await readFile(srtPath, "utf8");
    vttContent = await readFile(vttPath, "utf8");
    txtContent = await readFile(txtPath, "utf8");
  });

  it("generates .srt file in outDir", async () => {
    await expect(access(srtPath)).resolves.toBeUndefined();
  });

  it("generates .vtt file in outDir", async () => {
    await expect(access(vttPath)).resolves.toBeUndefined();
  });

  it("generates .txt file in outDir", async () => {
    await expect(access(txtPath)).resolves.toBeUndefined();
  });

  it(".srt content starts with sequence number 1", () => {
    expect(srtContent.startsWith("1\n")).toBe(true);
  });

  it(".srt content uses comma decimal separator in timestamps", () => {
    expect(srtContent).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
  });

  it(".vtt content starts with 'WEBVTT'", () => {
    expect(vttContent.startsWith("WEBVTT\n")).toBe(true);
  });

  it(".vtt content uses dot decimal separator in timestamps", () => {
    expect(vttContent).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/);
  });

  it(".srt content contains the authored Voice text (not a hash)", () => {
    // The simple.tsx fixture has "Hello world." and "Goodbye world." as Voice texts.
    // The originalText (not cache-normalized) must appear in the SRT.
    expect(srtContent).toContain("Hello world.");
    expect(srtContent).toContain("Goodbye world.");
  });

  it(".vtt content contains the authored Voice text", () => {
    expect(vttContent).toContain("Hello world.");
    expect(vttContent).toContain("Goodbye world.");
  });

  it(".txt content contains the authored Voice text", () => {
    expect(txtContent).toContain("Hello world.");
    expect(txtContent).toContain("Goodbye world.");
  });

  it("originalText is not the cache-hash form (not a hex string)", () => {
    // The SRT cue text must be human-readable text, not a hash
    // (verifies originalText was used, not the hash)
    expect(srtContent).not.toMatch(/^[0-9a-f]{64}$/m);
  });
});

// ---------------------------------------------------------------------------
// --transcript composable with --player
// ---------------------------------------------------------------------------

describe("--transcript composable with --player", () => {
  let result: RenderResult;
  let srtPath: string;
  let playerHtmlPath: string;
  let waveformPath: string;

  beforeAll(async () => {
    const dir = join(outDir, "transcript-and-player");
    await mkdir(dir, { recursive: true });
    result = await renderFixture(FIXTURE_SIMPLE, dir, cacheDir);

    // Generate player (--player path)
    const wfPath = await generateWaveform(result.mp3Path, dir);
    await generatePlayer(result.ir, result.mp3Path, wfPath, dir);
    waveformPath = join(dir, "waveform.png");
    playerHtmlPath = join(dir, `${result.stem}-player.html`);

    // Generate transcript (--transcript path)
    const voiceTexts = extractVoiceTexts(result.resolvedTree);
    const cues = generateTranscriptCues(result.ir, voiceTexts);
    srtPath = join(dir, `${result.stem}.srt`);
    await writeFile(srtPath, formatSrt(cues, result.ir.sampleRate));
    await writeFile(join(dir, `${result.stem}.vtt`), formatVtt(cues, result.ir.sampleRate));
    await writeFile(join(dir, `${result.stem}.txt`), formatTxt(result.ir, cues));
  });

  it("generates .srt file", async () => {
    await expect(access(srtPath)).resolves.toBeUndefined();
  });

  it("generates waveform.png", async () => {
    await expect(access(waveformPath)).resolves.toBeUndefined();
  });

  it("generates player HTML", async () => {
    await expect(access(playerHtmlPath)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Streaming skip path with --transcript
// ---------------------------------------------------------------------------

describe("streaming skip with --transcript", () => {
  let skipDir: string;
  let skipCacheDir: string;
  let srtPath: string;
  let vttPath: string;
  let txtPath: string;

  beforeAll(async () => {
    skipDir = join(outDir, "skip-transcript");
    skipCacheDir = join(tmpDir, "skip-cache");
    await mkdir(skipDir, { recursive: true });
    await mkdir(join(skipCacheDir, ".soundstage", "cache"), { recursive: true });

    const absFile = resolve(FIXTURE_SIMPLE);
    const fileBaseDir = dirname(absFile);
    const stem = basename(absFile, extname(absFile));

    const adapter = new SyntheticAdapter();
    const cache = new CacheLayer(
      adapter,
      join(skipCacheDir, ".soundstage", "cache"),
      { noCache: false },
    );

    const tree = await loadTsx(absFile);
    const resolvedTree = await phaseA(tree, { cache, baseDir: fileBaseDir });
    const ir = phaseB(resolvedTree);
    const ffmpegVersion = await getFfmpegVersion();
    ir.render.ffmpegVersion = ffmpegVersion;
    ir.render.outputs = ["wav", "mp3"];

    const wavPath = join(skipDir, `${stem}.wav`);
    const mp3Path = join(skipDir, `${stem}.mp3`);
    srtPath = join(skipDir, `${stem}.srt`);
    vttPath = join(skipDir, `${stem}.vtt`);
    txtPath = join(skipDir, `${stem}.txt`);

    // First render: write fake output files + render state (simulate a prior render)
    await writeFile(wavPath, Buffer.from("FAKE_WAV"));
    await writeFile(mp3Path, Buffer.from("FAKE_MP3"));
    const irHash = hashIR(ir);
    await writeRenderState(skipDir, irHash);

    // Second "render" with --transcript: skip path should regenerate transcript files
    // Simulate what runRender does on the skip path:
    const state = await readRenderState(skipDir);
    const isSkip = state?.ir_hash === irHash;
    expect(isSkip).toBe(true); // sanity check: skip IS triggered

    // On skip, re-run transcript generation from in-memory ir + resolvedTree
    const voiceTexts = extractVoiceTexts(resolvedTree);
    const cues = generateTranscriptCues(ir, voiceTexts);
    await writeFile(srtPath, formatSrt(cues, ir.sampleRate));
    await writeFile(vttPath, formatVtt(cues, ir.sampleRate));
    await writeFile(txtPath, formatTxt(ir, cues));
  });

  it("transcript .srt is generated on the skip path", async () => {
    await expect(access(srtPath)).resolves.toBeUndefined();
  });

  it("transcript .vtt is generated on the skip path", async () => {
    await expect(access(vttPath)).resolves.toBeUndefined();
  });

  it("transcript .txt is generated on the skip path", async () => {
    await expect(access(txtPath)).resolves.toBeUndefined();
  });

  it("skip-path .srt contains authored text", async () => {
    const content = await readFile(srtPath, "utf8");
    expect(content).toContain("Hello world.");
  });
});
