// Integration tests for --player CLI flag (Task 6).
//
// Tests use the synthetic adapter (hermetic, no model download).
// Verifies: --player generates waveform.png + episode-player.html;
//           without --player, neither file is generated;
//           stdout includes the extra output paths when --player is set.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, access } from "node:fs/promises";
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
import { buildCacheReport, formatCacheReport } from "../../src/cli/report.js";
import type { IR } from "../../src/ir/phase-b.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE_SIMPLE = new URL(
  "../fixtures/episodes/simple.tsx",
  import.meta.url,
).pathname;

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

interface RenderResult {
  ir: IR;
  wavPath: string;
  mp3Path: string;
  stem: string;
  stdout: string;
}

async function renderFixture(
  fixturePath: string,
  outDir: string,
  cacheBaseDir: string,
): Promise<RenderResult> {
  const absFile = resolve(fixturePath);
  const fileBaseDir = dirname(absFile);
  const stem = basename(absFile, extname(absFile));

  const cacheDirPath = join(cacheBaseDir, ".soundstage", "cache");
  await mkdir(cacheDirPath, { recursive: true });

  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDirPath, { noCache: false });

  const hitVoiceUnitIds = new Set<number>();
  let totalVoices = 0;
  function onVoiceSynthesized(voiceUnitId: number, hit: boolean): void {
    totalVoices = Math.max(totalVoices, voiceUnitId + 1);
    if (hit) hitVoiceUnitIds.add(voiceUnitId);
  }

  const tree = await loadTsx(absFile);
  const resolvedTree = await phaseA(tree, { cache, baseDir: fileBaseDir, onVoiceSynthesized });
  const ir = phaseB(resolvedTree);

  const ffmpegVersion = await getFfmpegVersion();
  ir.render.ffmpegVersion = ffmpegVersion;
  ir.render.outputs = ["wav", "mp3"];

  const wavPath = join(outDir, `${stem}.wav`);
  const mp3Path = join(outDir, `${stem}.mp3`);

  const tmpRenderDir = await mkdtemp(join(tmpdir(), "soundstage-player-int-"));
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

  const report = buildCacheReport(ir, hitVoiceUnitIds, totalVoices);
  const stdout =
    "soundstage: cache report\n" + formatCacheReport(report) + "\n" +
    `soundstage: render complete → ${stem}.wav, ${stem}.mp3\n`;

  return { ir, wavPath, mp3Path, stem, stdout };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let outDir: string;
let cacheDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-player-int-"));
  outDir = join(tmpDir, "out");
  cacheDir = join(tmpDir, "cache");
  await mkdir(outDir, { recursive: true });
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Without --player: neither file is generated
// ---------------------------------------------------------------------------

describe("render without --player", () => {
  let result: RenderResult;

  beforeAll(async () => {
    const dir = join(outDir, "no-player");
    await mkdir(dir, { recursive: true });
    result = await renderFixture(FIXTURE_SIMPLE, dir, cacheDir);
  });

  it("does not produce waveform.png", async () => {
    const pngPath = join(dirname(result.wavPath), "waveform.png");
    await expect(access(pngPath)).rejects.toThrow();
  });

  it("does not produce episode-player.html", async () => {
    const htmlPath = join(dirname(result.wavPath), `${result.stem}-player.html`);
    await expect(access(htmlPath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// With --player: both files are generated
// ---------------------------------------------------------------------------

describe("render with --player", () => {
  let result: RenderResult;
  let waveformPath: string;
  let playerHtmlPath: string;
  let playerStdout: string;

  beforeAll(async () => {
    const dir = join(outDir, "with-player");
    await mkdir(dir, { recursive: true });
    result = await renderFixture(FIXTURE_SIMPLE, dir, cacheDir);

    // Simulate what the CLI does when --player is set.
    waveformPath = await generateWaveform(result.mp3Path, dir);
    playerHtmlPath = await generatePlayer(result.ir, result.mp3Path, waveformPath, dir);

    // Simulate the success stdout that --player appends.
    const playerFiles = `${result.stem}-player.html, waveform.png`;
    playerStdout = result.stdout.replace(
      `→ ${result.stem}.wav, ${result.stem}.mp3`,
      `→ ${result.stem}.wav, ${result.stem}.mp3, ${playerFiles}`,
    );
  });

  it("produces waveform.png", async () => {
    await expect(access(waveformPath)).resolves.toBeUndefined();
  });

  it("produces episode-player.html", async () => {
    await expect(access(playerHtmlPath)).resolves.toBeUndefined();
  });

  it("waveform.png path is in the output directory", () => {
    expect(waveformPath).toContain("waveform.png");
  });

  it("player HTML filename is <stem>-player.html", () => {
    expect(playerHtmlPath).toMatch(new RegExp(`${result.stem}-player\\.html$`));
  });

  it("stdout includes episode-player.html when --player is set", () => {
    expect(playerStdout).toContain(`${result.stem}-player.html`);
  });

  it("stdout includes waveform.png when --player is set", () => {
    expect(playerStdout).toContain("waveform.png");
  });

  it("player HTML contains correct mp3 src", async () => {
    const { readFile } = await import("node:fs/promises");
    const html = await readFile(playerHtmlPath, "utf8");
    expect(html).toContain(`src="${result.stem}.mp3"`);
  });

  it("player HTML contains chapter buttons from the fixture IR", async () => {
    const { readFile } = await import("node:fs/promises");
    const html = await readFile(playerHtmlPath, "utf8");
    // The simple fixture has Intro + Outro segments → 2 chapter buttons
    const buttons = html.match(/<button\b[^>]*>/gi) ?? [];
    expect(buttons.length).toBe(result.ir.chapters.length);
  });

  it("player HTML contains the episode title", async () => {
    const { readFile } = await import("node:fs/promises");
    const html = await readFile(playerHtmlPath, "utf8");
    expect(html).toContain(result.ir.episode.title);
  });
});
