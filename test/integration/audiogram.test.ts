// Integration tests for Task 3: Audiogram / Social Video.
//
// Tests CLI flag behavior using two strategies:
//
// 1. Subprocess tests (describe.skipIf(!distExists)) — run the built binary to verify
//    flag validation, exit codes, and composability. These test the full Commander
//    wiring and actual process exit codes.
//
// 2. Module-level mocking — test the skip/generate logic by mocking generateAudiogram
//    and verifying call counts, without spawning real ffmpeg encode passes.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, mkdir, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, extname } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Detect drawtext support synchronously — standard Homebrew ffmpeg omits libfreetype.
function hasDrawtext(): boolean {
  const result = spawnSync("ffmpeg", ["-filters"], { encoding: "utf8" });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  return output.includes("drawtext");
}
const drawtextAvailable = hasDrawtext();

// ---------------------------------------------------------------------------
// Module mocks (for skip-behavior tests)
// ---------------------------------------------------------------------------

import type * as RunModule from "../../src/compiler/run.js";
import type * as LoudnormModule from "../../src/compiler/loudnorm.js";
import type * as EncodeModule from "../../src/compiler/encode.js";
import type * as ChaptersModule from "../../src/compiler/chapters.js";
import type * as PlayerModule from "../../src/compiler/player.js";
import type * as AudiogramModule from "../../src/compiler/audiogram.js";

vi.mock("../../src/compiler/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RunModule>();
  return {
    ...actual,
    runFfmpeg: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", scriptPath: null }),
  };
});

vi.mock("../../src/compiler/loudnorm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof LoudnormModule>();
  return { ...actual, applyLoudnorm: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../src/compiler/encode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof EncodeModule>();
  return { ...actual, encodeMp3: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../src/compiler/chapters.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ChaptersModule>();
  return { ...actual, runChapterPostPass: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../src/compiler/player.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PlayerModule>();
  return {
    ...actual,
    generateWaveform: vi.fn().mockImplementation((_mp3: string, outDir: string) =>
      Promise.resolve(join(outDir, "waveform.png")),
    ),
    generatePlayer: vi.fn().mockImplementation((_ir: unknown, _mp3: string, _wf: string, outDir: string) =>
      Promise.resolve(join(outDir, "simple-player.html")),
    ),
  };
});

vi.mock("../../src/compiler/audiogram.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AudiogramModule>();
  return {
    ...actual,
    generateAudiogram: vi.fn().mockImplementation(
      (_ir: unknown, mp3Path: string, _opts: unknown, outDir: string) => {
        const stem = basename(mp3Path).replace(/\.mp3$/i, "");
        return Promise.resolve(join(outDir, `${stem}-audiogram.mp4`));
      },
    ),
  };
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock)
// ---------------------------------------------------------------------------

import { loadTsx } from "../../src/cli/loader.js";
import { phaseA } from "../../src/ir/phase-a.js";
import { phaseB } from "../../src/ir/phase-b.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg, getFfmpegVersion } from "../../src/compiler/run.js";
import { generateWaveform, generatePlayer } from "../../src/compiler/player.js";
import { generateAudiogram } from "../../src/compiler/audiogram.js";
import { readRenderState, writeRenderState, hashIR } from "../../src/cli/render-state.js";

// ---------------------------------------------------------------------------
// CLI binary path (for subprocess tests)
// ---------------------------------------------------------------------------

const WORKTREE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI_ENTRY = join(WORKTREE_ROOT, "dist", "cli", "index.js");
const FIXTURE_SIMPLE = new URL("../fixtures/episodes/simple.tsx", import.meta.url).pathname;

const distExists = existsSync(CLI_ENTRY);

const execFileAsync = promisify(execFile);

/** Run the CLI binary; never throws — returns exit code. */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { encoding: "utf8", timeout: 120_000 },
      (err, stdout, stderr) => {
        const exitCode =
          err !== null && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : 0;
        resolve({ stdout: stdout as string, stderr: stderr as string, code: exitCode });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Pipeline helper (mirrors runRender streaming logic; mocked ffmpeg passes)
// ---------------------------------------------------------------------------

interface RenderResult {
  skipped: boolean;
  irHash: string;
  stem: string;
  wavPath: string;
  mp3Path: string;
  outDir: string;
}

async function runPipeline(
  fixturePath: string,
  outDir: string,
  cacheBaseDir: string,
  opts: {
    force?: boolean;
    video?: boolean;
    videoAspect?: string;
    videoColor?: string;
    videoLogo?: string;
    player?: boolean;
    ffmpegVersionOverride?: string;
  } = {},
): Promise<RenderResult> {
  const absFile = resolve(fixturePath);
  const fileBaseDir = dirname(absFile);
  const stem = basename(absFile, extname(absFile));

  const cacheDirPath = join(cacheBaseDir, ".soundstage", "cache");
  await mkdir(cacheDirPath, { recursive: true });

  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDirPath, { noCache: false });

  const chunkStats = new Map<number, { total: number; hits: number }>();
  function onVoiceSynthesized(voiceUnitId: number, _ci: number, _ct: number, hit: boolean): void {
    const s = chunkStats.get(voiceUnitId) ?? { total: 0, hits: 0 };
    s.total++;
    if (hit) s.hits++;
    chunkStats.set(voiceUnitId, s);
  }

  const tree = await loadTsx(absFile);
  const resolvedTree = await phaseA(tree, { cache, baseDir: fileBaseDir, onVoiceSynthesized });
  const ir = phaseB(resolvedTree);

  ir.render.ffmpegVersion = opts.ffmpegVersionOverride ?? (await getFfmpegVersion());
  ir.render.outputs = ["wav", "mp3"];

  const wavPath = join(outDir, `${stem}.wav`);
  const mp3Path = join(outDir, `${stem}.mp3`);

  const irHash = hashIR(ir);

  // Streaming skip check
  if (!opts.force) {
    const state = await readRenderState(outDir);
    if (state?.ir_hash === irHash) {
      let outputsExist = true;
      try {
        await access(wavPath);
        await access(mp3Path);
      } catch {
        outputsExist = false;
      }
      if (outputsExist) {
        // Skip path: generate player if requested (always)
        if (opts.player) {
          const waveformPath = await generateWaveform(mp3Path, outDir);
          await generatePlayer(ir, mp3Path, waveformPath, outDir);
        }
        // Skip path: generate audiogram if requested and mp4 doesn't exist
        if (opts.video) {
          const mp4Path = join(outDir, `${stem}-audiogram.mp4`);
          let mp4Exists = false;
          try {
            await access(mp4Path);
            mp4Exists = true;
          } catch { /* doesn't exist */ }
          if (!mp4Exists) {
            await generateAudiogram(ir, mp3Path, { aspect: opts.videoAspect as "square" | "landscape" | "vertical" | undefined }, outDir);
          }
        }
        return { skipped: true, irHash, stem, wavPath, mp3Path, outDir };
      }
    }
  }

  // Full pipeline
  await mkdir(outDir, { recursive: true });
  const compiled = compileIR(ir, join(outDir, "mix.f32.wav"));
  const mixResult = await runFfmpeg(compiled);
  if (mixResult.exitCode !== 0) {
    throw new Error(`mix failed: ${mixResult.stderr}`);
  }

  // Fake output files (mocked ffmpeg didn't create them)
  await writeFile(wavPath, Buffer.from("FAKE_WAV"));
  await writeFile(mp3Path, Buffer.from("FAKE_MP3"));

  await writeRenderState(outDir, irHash);

  // Post-finally region: player
  if (opts.player) {
    const waveformPath = await generateWaveform(mp3Path, outDir);
    await generatePlayer(ir, mp3Path, waveformPath, outDir);
  }

  // Post-finally region: audiogram
  if (opts.video) {
    await generateAudiogram(
      ir,
      mp3Path,
      {
        aspect: opts.videoAspect as "square" | "landscape" | "vertical" | undefined,
        accentColor: opts.videoColor,
        logoPath: opts.videoLogo,
      },
      outDir,
    );
  }

  return { skipped: false, irHash, stem, wavPath, mp3Path, outDir };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-audiogram-int-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Without --video: no mp4 generated
// ---------------------------------------------------------------------------

describe("without --video: no generateAudiogram call", () => {
  beforeAll(async () => {
    const outDir = join(tmpDir, "no-video");
    await mkdir(outDir, { recursive: true });
    vi.clearAllMocks();
    await runPipeline(FIXTURE_SIMPLE, outDir, join(tmpDir, "no-video-cache"));
  });

  it("generateAudiogram was NOT called", () => {
    expect(generateAudiogram).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// With --video: generateAudiogram is called
// ---------------------------------------------------------------------------

describe("with --video: generateAudiogram is called", () => {
  beforeAll(async () => {
    const outDir = join(tmpDir, "with-video");
    await mkdir(outDir, { recursive: true });
    vi.clearAllMocks();
    await runPipeline(FIXTURE_SIMPLE, outDir, join(tmpDir, "with-video-cache"), { video: true });
  });

  it("generateAudiogram was called once", () => {
    expect(generateAudiogram).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Composable with --player
// ---------------------------------------------------------------------------

describe("--video composable with --player", () => {
  beforeAll(async () => {
    const outDir = join(tmpDir, "compose-video-player");
    await mkdir(outDir, { recursive: true });
    vi.clearAllMocks();
    await runPipeline(FIXTURE_SIMPLE, outDir, join(tmpDir, "compose-cache"), {
      video: true,
      player: true,
    });
  });

  it("generateWaveform was called (--player)", () => {
    expect(generateWaveform).toHaveBeenCalledTimes(1);
  });

  it("generatePlayer was called (--player)", () => {
    expect(generatePlayer).toHaveBeenCalledTimes(1);
  });

  it("generateAudiogram was called (--video)", () => {
    expect(generateAudiogram).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Streaming skip: mp4 already exists → NOT regenerated
// ---------------------------------------------------------------------------

describe("streaming skip — mp4 exists → generateAudiogram NOT called", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = join(tmpDir, "skip-mp4-exists");
    await mkdir(outDir, { recursive: true });
    const cacheDir = join(tmpDir, "skip-mp4-cache");

    // First run: prime state + fake output files
    vi.clearAllMocks();
    const result = await runPipeline(FIXTURE_SIMPLE, outDir, cacheDir, { video: true });

    // Create a fake mp4 to simulate the file existing from the first run
    await writeFile(join(outDir, `${result.stem}-audiogram.mp4`), Buffer.from("FAKE_MP4"));

    // Second run: same IR + mp4 exists → skip should NOT call generateAudiogram
    vi.clearAllMocks();
    await runPipeline(FIXTURE_SIMPLE, outDir, cacheDir, { video: true });
  });

  it("generateAudiogram NOT called on skip when mp4 exists", () => {
    expect(generateAudiogram).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Streaming skip: mp4 does NOT exist → IS generated
// ---------------------------------------------------------------------------

describe("streaming skip — mp4 missing → generateAudiogram IS called", () => {
  beforeAll(async () => {
    const outDir = join(tmpDir, "skip-mp4-missing");
    await mkdir(outDir, { recursive: true });
    const cacheDir = join(tmpDir, "skip-mp4-missing-cache");

    // First run: prime state but do NOT create mp4 (video: false)
    vi.clearAllMocks();
    await runPipeline(FIXTURE_SIMPLE, outDir, cacheDir);

    // Second run: same IR, request video, mp4 doesn't exist → should generate
    vi.clearAllMocks();
    await runPipeline(FIXTURE_SIMPLE, outDir, cacheDir, { video: true });
  });

  it("generateAudiogram IS called on skip when mp4 is missing", () => {
    expect(generateAudiogram).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Subprocess tests — flag validation (requires built dist, no ffmpeg drawtext needed)
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)("CLI binary — --video flag validation", () => {
  let validOutDir: string;

  beforeAll(async () => {
    validOutDir = join(tmpDir, "binary-video");
    await mkdir(validOutDir, { recursive: true });
  });

  it("--video-aspect invalid exits 1 with clear error", async () => {
    const { code, stderr } = await runCli([
      "render", FIXTURE_SIMPLE, "--draft", "--video", "--video-aspect", "invalid-shape",
      "--out", validOutDir,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("invalid-shape");
  }, 30_000);

  it("--video-logo with non-existent path exits 1", async () => {
    const { code, stderr } = await runCli([
      "render", FIXTURE_SIMPLE, "--draft", "--video",
      "--video-logo", "/nonexistent-logo-file.png",
      "--out", validOutDir,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("logo");
  }, 30_000);

  it("--video-color with invalid value exits 1 with clear error", async () => {
    const { code, stderr } = await runCli([
      "render", FIXTURE_SIMPLE, "--draft", "--video", "--video-color", "not-a-color",
      "--out", validOutDir,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("hex");
  }, 30_000);

  // When drawtext is unavailable in the system ffmpeg (e.g. Homebrew without
  // libfreetype), --video causes a real ffmpeg failure → exit 3. This is a
  // useful coverage point: it verifies the error is caught and surfaced with
  // the right exit code end-to-end. Skipped when drawtext IS available (real
  // encode succeeds on those systems and is covered by the "real encode" suite).
  it.skipIf(drawtextAvailable)(
    "--video exits 3 with audiogram generation failed when ffmpeg lacks drawtext",
    async () => {
      const ffmpegFailDir = join(tmpDir, "binary-ffmpeg-fail");
      await mkdir(ffmpegFailDir, { recursive: true });
      const { code, stderr } = await runCli([
        "render", FIXTURE_SIMPLE, "--draft", "--video", "--out", ffmpegFailDir,
      ]);
      expect(code).toBe(3);
      expect(stderr).toContain("audiogram generation failed:");
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Subprocess tests — real ffmpeg encode (requires built dist + drawtext support)
// ---------------------------------------------------------------------------

describe.skipIf(!distExists || !drawtextAvailable)("CLI binary — --video real encode", () => {
  it("--video produces <stem>-audiogram.mp4 in outDir", async () => {
    const videoOutDir = join(tmpDir, "binary-video-out");
    await mkdir(videoOutDir, { recursive: true });

    const { code } = await runCli([
      "render", FIXTURE_SIMPLE, "--draft", "--video",
      "--out", videoOutDir,
    ]);

    expect(code).toBe(0);
    await expect(access(join(videoOutDir, "simple-audiogram.mp4"))).resolves.toBeUndefined();
  }, 120_000);

  it("stdout success line includes <stem>-audiogram.mp4", async () => {
    const videoOutDir2 = join(tmpDir, "binary-video-stdout");
    await mkdir(videoOutDir2, { recursive: true });

    const { code, stdout } = await runCli([
      "render", FIXTURE_SIMPLE, "--draft", "--video",
      "--out", videoOutDir2,
    ]);

    expect(code).toBe(0);
    const successLine = stdout.split("\n").find((l) => l.startsWith("soundstage: render complete"));
    expect(successLine).toBeDefined();
    expect(successLine).toContain("simple-audiogram.mp4");
  }, 120_000);

  it("--video --player produces mp4 + waveform.png + player.html", async () => {
    const composedOutDir = join(tmpDir, "binary-composed");
    await mkdir(composedOutDir, { recursive: true });

    const { code } = await runCli([
      "render", FIXTURE_SIMPLE, "--draft", "--video", "--player",
      "--out", composedOutDir,
    ]);

    expect(code).toBe(0);
    await expect(access(join(composedOutDir, "simple-audiogram.mp4"))).resolves.toBeUndefined();
    await expect(access(join(composedOutDir, "waveform.png"))).resolves.toBeUndefined();
    await expect(access(join(composedOutDir, "simple-player.html"))).resolves.toBeUndefined();
  }, 120_000);

  it("unchanged re-run with --video and existing mp4 prints 'up to date' skip message", async () => {
    const skipOutDir = join(tmpDir, "binary-skip-video");
    await mkdir(skipOutDir, { recursive: true });

    // First run
    await execFileAsync(
      process.execPath,
      [CLI_ENTRY, "render", FIXTURE_SIMPLE, "--draft", "--video", "--out", skipOutDir],
      { encoding: "utf8", timeout: 120_000 },
    );

    // Second run (should skip)
    const { code, stdout } = await runCli([
      "render", FIXTURE_SIMPLE, "--draft", "--video", "--out", skipOutDir,
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("no changes");
    expect(stdout).toContain("audiogram.mp4");
  }, 240_000);
});
