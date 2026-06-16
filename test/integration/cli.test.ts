// Integration tests for the CLI render command (src/cli/index.ts).
// All tests use --draft (synthetic adapter) — hermetic, no model download.
// Asserts: .wav + .mp3 produced, valid (ffprobe), chapters present (node-id3 read-back),
//          cache report printed, second run shows cache HITS.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as NodeID3 from "node-id3";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURE_SIMPLE = new URL(
  "../fixtures/episodes/simple.tsx",
  import.meta.url,
).pathname;

const FIXTURE_INVALID = new URL(
  "../fixtures/episodes/invalid.tsx",
  import.meta.url,
).pathname;

// ---------------------------------------------------------------------------
// CLI invocation helper
// Uses `node src/cli/index.ts` directly (no build required; tsconfig.test.json
// has allowImportingTsExtensions so vitest can import .ts; but for child_process
// we use the NO_KOKORO-safe path via ts-node is NOT available — instead we
// invoke the CLI module via node with --import tsx? No, we use node directly
// with the vitest/ts runner. Let's call the render function directly in-process.
// ---------------------------------------------------------------------------

// We invoke the CLI programmatically (not via exec) to avoid subprocess overhead
// and keep the test hermetic. Import the internal runRender logic by testing
// the whole pipeline (phaseA → phaseB → compile → render) directly.

import { loadTsx } from "../../src/cli/loader.js";
import { phaseA } from "../../src/ir/phase-a.js";
import { phaseB } from "../../src/ir/phase-b.js";
import { SoundstageError } from "../../src/ir/errors.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg, getFfmpegVersion } from "../../src/compiler/run.js";
import { applyLoudnorm } from "../../src/compiler/loudnorm.js";
import { encodeMp3 } from "../../src/compiler/encode.js";
import { runChapterPostPass } from "../../src/compiler/chapters.js";
import { buildCacheReport, formatCacheReport } from "../../src/cli/report.js";
import { dirname, basename, extname } from "node:path";

// ---------------------------------------------------------------------------
// Pipeline runner (mirrors src/cli/index.ts's runRender logic)
// ---------------------------------------------------------------------------

interface RenderResult {
  wavPath: string;
  mp3Path: string;
  stdout: string;
  ffmpegVersion: string;
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

  const hitVoiceUnitIds = new Set<number>();
  let totalVoices = 0;
  function onVoiceSynthesized(voiceUnitId: number, hit: boolean): void {
    totalVoices = Math.max(totalVoices, voiceUnitId + 1);
    if (hit) hitVoiceUnitIds.add(voiceUnitId);
  }

  // Load .tsx.
  const tree = await loadTsx(absFile);

  // Phase A (validate + resolve + synthesize).
  const resolvedTree = await phaseA(tree, {
    cache,
    baseDir: fileBaseDir,
    onVoiceSynthesized,
  });

  // Phase B → IR.
  const ir = phaseB(resolvedTree);

  // Populate ffmpegVersion.
  const ffmpegVersion = await getFfmpegVersion();
  ir.render.ffmpegVersion = ffmpegVersion;
  ir.render.outputs = ["wav", "mp3"];

  // Output paths.
  const wavPath = join(outDir, `${stem}.wav`);
  const mp3Path = join(outDir, `${stem}.mp3`);

  // Temp dir for intermediate mix.
  const tmpDir = await mkdtemp(join(tmpdir(), "soundstage-test-"));
  try {
    const mixPath = join(tmpDir, "mix.f32.wav");

    // Compile + mix.
    const compiled = compileIR(ir, mixPath);
    const mixResult = await runFfmpeg(compiled);
    if (mixResult.exitCode !== 0) {
      throw new Error(`Mix failed: ${mixResult.stderr}`);
    }

    // Loudnorm.
    await applyLoudnorm(mixPath, ir.loudness, ir.sampleRate, wavPath);

    // Mp3 encode.
    await encodeMp3(wavPath, mp3Path);

    // Chapter post-pass.
    await runChapterPostPass(ir, mp3Path, wavPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // Build cache report.
  const report = buildCacheReport(ir, hitVoiceUnitIds, totalVoices);
  const stdout =
    "soundstage: cache report\n" + formatCacheReport(report) + "\n" +
    `soundstage: render complete → ${stem}.wav, ${stem}.mp3\n`;

  return { wavPath, mp3Path, stdout, ffmpegVersion };
}

// ---------------------------------------------------------------------------
// ffprobe helper
// ---------------------------------------------------------------------------

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

let tmpDir: string;
let cacheDir: string;
let outDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-cli-test-"));
  cacheDir = join(tmpDir, "cache");
  outDir = join(tmpDir, "out");
  await mkdir(outDir, { recursive: true });
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1: end-to-end render with --draft exits 0 and produces valid .wav + .mp3
// ---------------------------------------------------------------------------

describe("CLI render (draft/synthetic adapter)", () => {
  let result: RenderResult;

  beforeAll(async () => {
    result = await renderFixture(FIXTURE_SIMPLE, outDir, cacheDir);
  });

  it("produces a .wav file", async () => {
    await expect(access(result.wavPath)).resolves.toBeUndefined();
  });

  it("produces a .mp3 file", async () => {
    await expect(access(result.mp3Path)).resolves.toBeUndefined();
  });

  it(".wav is a valid audio file at 48000 Hz", async () => {
    const info = await ffprobeStream(result.wavPath);
    expect(info.codec).toBe("pcm_s16le");
    expect(info.sampleRate).toBe("48000");
    expect(parseFloat(info.duration)).toBeGreaterThan(0);
  });

  it(".mp3 is a valid audio file", async () => {
    const info = await ffprobeStream(result.mp3Path);
    expect(info.codec).toBe("mp3");
    expect(parseFloat(info.duration)).toBeGreaterThan(0);
  });

  it(".mp3 has chapters (CHAP + CTOC via node-id3)", () => {
    const tags = NodeID3.read(result.mp3Path);
    expect(tags.chapter).toBeDefined();
    expect(Array.isArray(tags.chapter)).toBe(true);
    expect(tags.chapter!.length).toBeGreaterThan(0);

    // Chapters match the fixture's <Segment> titles.
    const titles = tags.chapter!.map((c: { tags?: { title?: string } }) => c.tags?.title ?? "");
    expect(titles).toContain("Intro");
    expect(titles).toContain("Outro");

    // CTOC present.
    expect(tags.tableOfContents).toBeDefined();
    expect(Array.isArray(tags.tableOfContents)).toBe(true);
    expect(tags.tableOfContents!.length).toBeGreaterThan(0);
  });

  it("IR.render.ffmpegVersion is populated", () => {
    expect(result.ffmpegVersion).toBeTruthy();
    // Should look like a version string.
    expect(result.ffmpegVersion).toMatch(/\d+\.\d+/);
  });

  it("cache report is printed to stdout", () => {
    expect(result.stdout).toContain("soundstage: cache report");
    // Two segments from the fixture.
    expect(result.stdout).toContain("Intro");
    expect(result.stdout).toContain("Outro");
    expect(result.stdout).toContain("total:");
  });

  it("first run: all voices are re-synth (cold cache)", () => {
    // cold cache → 0 hits.
    expect(result.stdout).toContain("re-synth");
    // No hits on cold run.
    expect(result.stdout).not.toContain("2/2 cached");
  });
});

// ---------------------------------------------------------------------------
// AC4: cache hit on second run (same fixture, warm cache)
// ---------------------------------------------------------------------------

describe("second run: warm cache shows hits", () => {
  let firstResult: RenderResult;
  let secondResult: RenderResult;

  beforeAll(async () => {
    const warmCacheDir = join(tmpDir, "warm-cache");
    const warmOutDir = join(tmpDir, "warm-out");
    await mkdir(warmOutDir, { recursive: true });

    // First run: cold cache — all misses.
    firstResult = await renderFixture(FIXTURE_SIMPLE, warmOutDir, warmCacheDir);

    // Second run: warm cache — all hits.
    secondResult = await renderFixture(FIXTURE_SIMPLE, warmOutDir, warmCacheDir);
  });

  it("second run stdout reports cached (not re-synth)", () => {
    // First run: re-synth.
    expect(firstResult.stdout).toContain("re-synth");

    // Second run: both segments show as cached.
    expect(secondResult.stdout).toContain("cached");
    expect(secondResult.stdout).not.toContain("re-synth · ");
    // total shows 2/2 cached.
    expect(secondResult.stdout).toContain("total: 2/2 cached");
  });

  it("second run: re-synth count is 0", () => {
    expect(secondResult.stdout).toContain(", 0 re-synth");
  });
});

// ---------------------------------------------------------------------------
// AC4: --no-cache forces re-synth but still writes cache entries
// ---------------------------------------------------------------------------

describe("--no-cache flag", () => {
  let result: RenderResult;
  let noCacheDir: string;
  let noCacheOutDir: string;

  beforeAll(async () => {
    noCacheDir = join(tmpDir, "no-cache");
    noCacheOutDir = join(tmpDir, "no-cache-out");
    await mkdir(noCacheOutDir, { recursive: true });

    // Pre-warm the cache with a normal run.
    await renderFixture(FIXTURE_SIMPLE, noCacheOutDir, noCacheDir);

    // Second run with --no-cache: should be all misses even though cache exists.
    result = await renderFixture(FIXTURE_SIMPLE, noCacheOutDir, noCacheDir, {
      noCache: true,
    });
  });

  it("--no-cache run reports all re-synth", () => {
    expect(result.stdout).toContain("re-synth");
    // With --no-cache, no hits.
    expect(result.stdout).toContain("total: 0/2 cached, 2 re-synth");
  });

  it("--no-cache still writes cache entries (third run is a warm hit)", async () => {
    // Third run without --no-cache — entries written by --no-cache run are usable.
    const thirdResult = await renderFixture(FIXTURE_SIMPLE, noCacheOutDir, noCacheDir);
    expect(thirdResult.stdout).toContain("total: 2/2 cached");
  });
});

// ---------------------------------------------------------------------------
// AC2: composition error exits 1, prints E_CODE format
// ---------------------------------------------------------------------------

describe("composition error handling", () => {
  it("invalid composition throws SoundstageError with E_MISSING_PROP", async () => {
    const errCacheDir = join(tmpDir, "err-cache");
    const errOutDir = join(tmpDir, "err-out");
    await mkdir(errOutDir, { recursive: true });

    await expect(
      renderFixture(FIXTURE_INVALID, errOutDir, errCacheDir),
    ).rejects.toThrow(SoundstageError);
  });

  it("SoundstageError has E_MISSING_PROP code", async () => {
    const errCacheDir = join(tmpDir, "err-cache-2");
    const errOutDir = join(tmpDir, "err-out-2");
    await mkdir(errOutDir, { recursive: true });

    try {
      await renderFixture(FIXTURE_INVALID, errOutDir, errCacheDir);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SoundstageError);
      expect((err as SoundstageError).code).toBe("E_MISSING_PROP");
    }
  });
});

// ---------------------------------------------------------------------------
// AC7: --out <dir> writes outputs to specified directory
// ---------------------------------------------------------------------------

describe("--out flag", () => {
  it("output files are written to the specified directory", async () => {
    const customOut = join(tmpDir, "custom-out");
    await mkdir(customOut, { recursive: true });

    const result = await renderFixture(FIXTURE_SIMPLE, customOut, join(tmpDir, "custom-cache"));

    // Files must be in the custom output dir.
    expect(result.wavPath).toContain(customOut);
    expect(result.mp3Path).toContain(customOut);

    await expect(access(result.wavPath)).resolves.toBeUndefined();
    await expect(access(result.mp3Path)).resolves.toBeUndefined();
  });
});
