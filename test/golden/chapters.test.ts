// Golden tests for Task 10: node-id3 Chapter + Artwork Post-Pass (CHAP + CTOC).
//
// Footgun: ffmpeg omits CTOC for mp3 (trac #7940) — post-pass must write it.
// Footgun: last chapter endMs must align with total duration (players loop/skip past end otherwise).
// Footgun: NodeID3.update() accumulates CHAP/CTOC on re-render — must use write().
//
// Strategy: produce a real mp3 via the full pipeline (synthetic adapter + ffmpeg),
// then call runChapterPostPass() and read tags back with node-id3.read() to assert
// CHAP + CTOC frames, ms values, and APIC (artwork) presence.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeID3 from "node-id3";
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg } from "../../src/compiler/run.js";
import { applyLoudnorm } from "../../src/compiler/loudnorm.js";
import { encodeMp3 } from "../../src/compiler/encode.js";
import { runChapterPostPass, samplesToMs } from "../../src/compiler/chapters.js";
import { runFfprobe } from "../../src/probe/ffprobe.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import type { IR, ChapterIR } from "../../src/ir/phase-b.js";

const SR = 48000;

// Path to the tiny PNG fixture (1×1 white pixel — valid PNG, minimal size).
const COVER_PNG = new URL("../fixtures/cover.png", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Pipeline helper — produces episode.mp3 from a two-clip IR
// ---------------------------------------------------------------------------

async function buildMp3(ir: IR, outDir: string): Promise<{ mp3Path: string; masterWavPath: string }> {
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
  return { mp3Path, masterWavPath };
}

/** Build a two-segment IR using already-synthesized cache clips. */
function buildIR(
  wavA: string,
  durA: number,
  wavB: string,
  durB: number,
  artwork?: string,
  author?: string,
): IR {
  const chapters: ChapterIR[] = [
    { title: "Intro", startSample: 0, endSample: durA },
    { title: "Main",  startSample: durA, endSample: durA + durB },
  ];
  return {
    schemaVersion: 2,
    sampleRate: SR,
    channels: 1,
    episode: {
      title: "Chapter Golden Test",
      ...(author !== undefined ? { author } : {}),
      ...(artwork ? { artwork } : {}),
    },
    tracks: [{ trackId: "voice" }],
    clips: [
      {
        id: "c0",
        sourceRef: { kind: "cache", path: wavA },
        trackId: "voice",
        startSample: 0,
        durationSamples: durA,
        gainDb: 0,
      },
      {
        id: "c1",
        sourceRef: { kind: "cache", path: wavB },
        trackId: "voice",
        startSample: durA,
        durationSamples: durB,
        gainDb: 0,
      },
    ],
    ducking: [],
    chapters,
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav", "mp3"] },
  };
}

// ---------------------------------------------------------------------------
// Test setup: synthesize two clips once, reuse across all golden tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let cacheDir: string;
let wavA: string;
let durA: number;
let wavB: string;
let durB: number;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-chapters-"));
  cacheDir = join(tmpDir, "cache");
  await mkdir(cacheDir, { recursive: true });

  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDir);

  const resA = await cache.get({ text: "chapter golden test intro segment", voice: "host", sampleRate: 24000 });
  wavA = resA.wavPath;
  durA = resA.durationSamples * 2; // 24k → 48k master rate

  const resB = await cache.get({ text: "chapter golden test main content segment", voice: "host", sampleRate: 24000 });
  wavB = resB.wavPath;
  durB = resB.durationSamples * 2;
}, 60_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC: CHAP frames present with correct titles and ms values
// AC: CTOC frame present listing all chapter element IDs
// AC: lastChapter.endMs === Math.round(totalDurationSamples / sampleRate * 1000)
// ---------------------------------------------------------------------------

describe("chapters golden: CHAP + CTOC round-trip", () => {
  it("node-id3.read() returns chapter and tableOfContents; lastChapter.endMs pinned to ffprobe-measured totalMs", async () => {
    const outDir = join(tmpDir, "chap-ctoc");
    await mkdir(outDir, { recursive: true });

    const ir = buildIR(wavA, durA, wavB, durB, undefined, "Golden Author");
    const { mp3Path, masterWavPath } = await buildMp3(ir, outDir);

    // runChapterPostPass ffprobes the master WAV for the real total sample count —
    // no * 2 estimate, no IR-summed guess.
    await runChapterPostPass(ir, mp3Path, masterWavPath);

    // Independently ffprobe the master WAV to verify the exact totalSamples used.
    const probeFields = await runFfprobe(masterWavPath, "stream=nb_samples,sample_rate,duration_ts,duration");
    const ffprobedTotalSamples =
      probeFields.nbSamples ??
      probeFields.durationTs ??
      (probeFields.durationSec !== undefined && probeFields.sampleRate > 0
        ? Math.round(probeFields.durationSec * probeFields.sampleRate)
        : undefined);
    if (ffprobedTotalSamples === undefined) {
      throw new Error("ffprobe: could not determine totalSamples from master WAV");
    }
    const expectedEndMs = Math.round((ffprobedTotalSamples / SR) * 1000);

    const tags = NodeID3.read(mp3Path);

    // CHAP: must be present with two entries
    expect(tags.chapter, "chapter array must be present").toBeDefined();
    expect(tags.chapter!.length, "two chapter entries").toBe(2);

    // Chapter 0: "Intro"
    const ch0 = tags.chapter![0]!;
    expect(ch0.tags?.title).toBe("Intro");
    expect(ch0.startTimeMs).toBe(samplesToMs(0, SR));
    expect(ch0.endTimeMs).toBe(samplesToMs(durA, SR));

    // Chapter 1: "Main" — endMs pinned to ffprobe-measured totalMs (not ch.endSample)
    const ch1 = tags.chapter![1]!;
    expect(ch1.tags?.title).toBe("Main");
    expect(ch1.startTimeMs).toBe(samplesToMs(durA, SR));
    // Exact equality: last chapter endMs must equal Math.round(ffprobedTotalSamples / sampleRate * 1000).
    expect(
      ch1.endTimeMs,
      "lastChapter.endMs must equal Math.round(ffprobedTotalSamples / sampleRate * 1000)",
    ).toBe(expectedEndMs);

    // CTOC: must be present and list both chapter element IDs in order
    expect(tags.tableOfContents, "tableOfContents must be present").toBeDefined();
    expect(tags.tableOfContents!.length).toBeGreaterThanOrEqual(1);
    const toc = tags.tableOfContents![0]!;
    expect(toc.elements, "CTOC elements must list both chapters").toHaveLength(2);
    expect(toc.elements![0]).toBe(ch0.elementID);
    expect(toc.elements![1]).toBe(ch1.elementID);

    // Episode-level text frames: TIT2 + TPE1
    expect(tags.title, "TIT2 must equal ir.episode.title").toBe("Chapter Golden Test");
    expect(tags.artist, "TPE1 must equal ir.episode.author").toBe("Golden Author");
  }, 120_000);

  it("no TPE1 frame and no crash when episode.author is absent", async () => {
    const outDir = join(tmpDir, "chap-ctoc-no-author");
    await mkdir(outDir, { recursive: true });

    const ir = buildIR(wavA, durA, wavB, durB); // no author
    const { mp3Path, masterWavPath } = await buildMp3(ir, outDir);

    await expect(runChapterPostPass(ir, mp3Path, masterWavPath)).resolves.not.toThrow();

    const tags = NodeID3.read(mp3Path);
    expect(tags.title).toBe("Chapter Golden Test");
    expect(tags.artist).toBeUndefined();
    expect(tags.chapter).toHaveLength(2);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// AC: artwork APIC frame when episode.artwork is set
// AC: no APIC and no crash when episode.artwork is absent
// ---------------------------------------------------------------------------

describe("chapters golden: artwork (APIC)", () => {
  it("node-id3.read() returns image object with image/* MIME after post-pass with PNG artwork", async () => {
    const outDir = join(tmpDir, "with-artwork");
    await mkdir(outDir, { recursive: true });

    const ir = buildIR(wavA, durA, wavB, durB, COVER_PNG);
    const { mp3Path, masterWavPath } = await buildMp3(ir, outDir);

    await runChapterPostPass(ir, mp3Path, masterWavPath);

    const tags = NodeID3.read(mp3Path);
    expect(tags.image, "APIC frame must be present when artwork is set").toBeDefined();
    // Force object shape — if node-id3 returns a string, this assertion fails explicitly
    expect(typeof tags.image).toBe("object");
    const img = tags.image as { mime: string; type: { id: number } };
    expect(img.mime).toMatch(/^image\//);
    expect(img.type.id).toBe(NodeID3.TagConstants.AttachedPicture.PictureType.FRONT_COVER);
  }, 120_000);

  it("no crash and no APIC frame when episode.artwork is absent", async () => {
    const outDir = join(tmpDir, "no-artwork");
    await mkdir(outDir, { recursive: true });

    const ir = buildIR(wavA, durA, wavB, durB);
    const { mp3Path, masterWavPath } = await buildMp3(ir, outDir);

    await expect(runChapterPostPass(ir, mp3Path, masterWavPath)).resolves.not.toThrow();

    const tags = NodeID3.read(mp3Path);
    expect(tags.image).toBeUndefined();
  }, 120_000);

  it("empty chapters + artwork: APIC written without CHAP/CTOC, no crash", async () => {
    const outDir = join(tmpDir, "empty-chapters-artwork");
    await mkdir(outDir, { recursive: true });

    // Build a minimal single-clip IR with no chapters (empty chapters[])
    const ir: IR = {
      schemaVersion: 2,
      sampleRate: SR,
      channels: 1,
      episode: { title: "No Chapters", artwork: COVER_PNG },
      tracks: [{ trackId: "voice" }],
      clips: [
        {
          id: "c0",
          sourceRef: { kind: "cache", path: wavA },
          trackId: "voice",
          startSample: 0,
          durationSamples: durA,
          gainDb: 0,
        },
      ],
      ducking: [],
      chapters: [], // empty
      loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
      render: { outputs: ["wav", "mp3"] },
    };
    const { mp3Path, masterWavPath } = await buildMp3(ir, outDir);

    await expect(runChapterPostPass(ir, mp3Path, masterWavPath)).resolves.not.toThrow();

    const tags = NodeID3.read(mp3Path);
    // Artwork must be embedded even with no chapters
    expect(tags.image, "APIC must be written for artwork-only post-pass").toBeDefined();
    // No chapter frames expected
    expect(tags.chapter ?? []).toHaveLength(0);
  }, 120_000);
});
