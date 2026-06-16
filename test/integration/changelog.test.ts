// End-to-end test for examples/changelog.tsx using --draft (synthetic adapter).
// CI-safe: no Kokoro model, no network. Asserts valid wav+mp3 with 3 chapters.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as NodeID3 from "node-id3";

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
import { buildCacheReport, formatCacheReport } from "../../src/cli/report.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RenderResult {
  wavPath: string;
  mp3Path: string;
  cacheReport: string;
}

async function renderChangelog(
  outDir: string,
  cacheBaseDir: string,
): Promise<RenderResult> {
  const changelogPath = new URL(
    "../../examples/changelog.tsx",
    import.meta.url,
  ).pathname;

  const absFile = resolve(changelogPath);
  const fileBaseDir = dirname(absFile);
  const stem = basename(absFile, extname(absFile));

  const cacheDirPath = join(cacheBaseDir, ".soundstage", "cache");
  await mkdir(cacheDirPath, { recursive: true });

  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDirPath);

  const hitVoiceUnitIds = new Set<number>();
  let totalVoices = 0;
  function onVoiceSynthesized(voiceUnitId: number, hit: boolean): void {
    totalVoices = Math.max(totalVoices, voiceUnitId + 1);
    if (hit) hitVoiceUnitIds.add(voiceUnitId);
  }

  const tree = await loadTsx(absFile);

  const resolvedTree = await phaseA(tree, {
    cache,
    baseDir: fileBaseDir,
    onVoiceSynthesized,
  });

  const ir = phaseB(resolvedTree);

  const ffmpegVersion = await getFfmpegVersion();
  ir.render.ffmpegVersion = ffmpegVersion;
  ir.render.outputs = ["wav", "mp3"];

  const wavPath = join(outDir, `${stem}.wav`);
  const mp3Path = join(outDir, `${stem}.mp3`);

  const tmpMixDir = await mkdtemp(join(tmpdir(), "soundstage-changelog-"));
  try {
    const mixPath = join(tmpMixDir, "mix.f32.wav");
    const compiled = compileIR(ir, mixPath);
    const mixResult = await runFfmpeg(compiled);
    if (mixResult.exitCode !== 0) {
      throw new Error(`Mix failed: ${mixResult.stderr}`);
    }
    await applyLoudnorm(mixPath, ir.loudness, ir.sampleRate, wavPath);
    await encodeMp3(wavPath, mp3Path);
    await runChapterPostPass(ir, mp3Path, wavPath);
  } finally {
    await rm(tmpMixDir, { recursive: true, force: true });
  }

  const report = buildCacheReport(ir, hitVoiceUnitIds, totalVoices);
  const cacheReport = formatCacheReport(report);

  return { wavPath, mp3Path, cacheReport };
}

async function ffprobeStream(filePath: string): Promise<{
  codec: string;
  sampleRate: string;
  duration: string;
}> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,sample_rate,duration",
    "-of", "default=noprint_wrappers=1",
    filePath,
  ], { encoding: "utf8" });

  const get = (key: string): string =>
    stdout.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() ?? "";

  return {
    codec: get("codec_name"),
    sampleRate: get("sample_rate"),
    duration: get("duration"),
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpRoot: string;
let outDir: string;
let cacheDir: string;
let result: RenderResult;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "soundstage-changelog-e2e-"));
  outDir = join(tmpRoot, "out");
  cacheDir = join(tmpRoot, "cache");
  await mkdir(outDir, { recursive: true });
  result = await renderChangelog(outDir, cacheDir);
}, 60_000);

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC: outputs
// ---------------------------------------------------------------------------

describe("changelog.tsx --draft render", () => {
  it("produces a .wav file", async () => {
    await expect(access(result.wavPath)).resolves.toBeUndefined();
  });

  it("produces a .mp3 file", async () => {
    await expect(access(result.mp3Path)).resolves.toBeUndefined();
  });

  it(".wav is valid 48kHz pcm_s16le", async () => {
    const info = await ffprobeStream(result.wavPath);
    expect(info.codec).toBe("pcm_s16le");
    expect(info.sampleRate).toBe("48000");
    expect(parseFloat(info.duration)).toBeGreaterThan(0);
  });

  it(".mp3 is a valid mp3", async () => {
    const info = await ffprobeStream(result.mp3Path);
    expect(info.codec).toBe("mp3");
    expect(parseFloat(info.duration)).toBeGreaterThan(0);
  });

  it(".mp3 has exactly 3 chapter entries", () => {
    const tags = NodeID3.read(result.mp3Path);
    expect(tags.chapter).toBeDefined();
    expect(Array.isArray(tags.chapter)).toBe(true);
    expect(tags.chapter!.length).toBe(3);
  });

  it(".mp3 chapters have the expected titles: Intro, What's New, Outro", () => {
    const tags = NodeID3.read(result.mp3Path);
    const titles = tags.chapter!.map(
      (c: { tags?: { title?: string } }) => c.tags?.title ?? "",
    );
    expect(titles).toContain("Intro");
    expect(titles).toContain("What's New");
    expect(titles).toContain("Outro");
  });

  it(".mp3 has a CTOC table of contents", () => {
    const tags = NodeID3.read(result.mp3Path);
    expect(tags.tableOfContents).toBeDefined();
    expect(Array.isArray(tags.tableOfContents)).toBe(true);
    expect(tags.tableOfContents!.length).toBeGreaterThan(0);
  });

  it("cache report contains all 3 segment titles", () => {
    expect(result.cacheReport).toContain("Intro");
    expect(result.cacheReport).toContain("What's New");
    expect(result.cacheReport).toContain("Outro");
  });
});
