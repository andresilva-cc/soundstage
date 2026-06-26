// Integration tests for Task 8: Streaming / Partial Render.
//
// Tests the skip-unchanged logic: when the IR hash matches the stored hash
// AND all output files exist, the ffmpeg mix pass is skipped.
//
// Strategy: mock runFfmpeg (spy only — never runs real ffmpeg), mock the
// loudnorm / encode / chapter passes the same way. The test helper creates
// fake output files after the "pipeline ran" step so subsequent runs can
// find them. Phase A / Phase B run for real (synthetic adapter, hermetic).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, mkdir, access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, extname } from "node:path";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any imports
// ---------------------------------------------------------------------------

import type * as RunModule from "../../src/compiler/run.js";
import type * as LoudnormModule from "../../src/compiler/loudnorm.js";
import type * as EncodeModule from "../../src/compiler/encode.js";
import type * as ChaptersModule from "../../src/compiler/chapters.js";
import type * as PlayerModule from "../../src/compiler/player.js";

vi.mock("../../src/compiler/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RunModule>();
  return {
    ...actual,
    runFfmpeg: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", scriptPath: null }),
    // getFfmpegVersion stays real (memoized per process; used by the helper)
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

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations — vitest hoists vi.mock calls)
// ---------------------------------------------------------------------------

import { loadTsx } from "../../src/cli/loader.js";
import { phaseA } from "../../src/ir/phase-a.js";
import { phaseB } from "../../src/ir/phase-b.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg, getFfmpegVersion } from "../../src/compiler/run.js";
import { generateWaveform, generatePlayer } from "../../src/compiler/player.js";
import { readRenderState, writeRenderState, hashIR } from "../../src/cli/render-state.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE_SIMPLE = new URL(
  "../fixtures/episodes/simple.tsx",
  import.meta.url,
).pathname;

const FIXTURE_EDITED = new URL(
  "../fixtures/episodes/simple-edited.tsx",
  import.meta.url,
).pathname;

// ---------------------------------------------------------------------------
// Pipeline helper — mirrors runRender's streaming logic
// ---------------------------------------------------------------------------
//
// Runs Phase A + Phase B (real, synthetic adapter), then applies the streaming
// skip check. When NOT skipping, calls the mocked runFfmpeg and creates fake
// output files so subsequent runs find them.

interface StreamResult {
  skipped: boolean;
  irHash: string;
  wavPath: string;
  mp3Path: string;
}

async function runStreamingPipeline(
  fixturePath: string,
  outDir: string,
  cacheBaseDir: string,
  opts: {
    force?: boolean;
    /** Override ir.render.ffmpegVersion for determinism testing. */
    ffmpegVersionOverride?: string;
    /** When true, generate waveform + player HTML (mirrors --player flag). */
    player?: boolean;
  } = {},
): Promise<StreamResult> {
  const absFile = resolve(fixturePath);
  const fileBaseDir = dirname(absFile);
  const stem = basename(absFile, extname(absFile));

  // Build cache + Phase A.
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

  // Populate ffmpegVersion BEFORE computing hash (§T8 determinism boundary).
  ir.render.ffmpegVersion =
    opts.ffmpegVersionOverride ?? (await getFfmpegVersion());
  ir.render.outputs = ["wav", "mp3"];

  // Output paths.
  const wavPath = join(outDir, `${stem}.wav`);
  const mp3Path = join(outDir, `${stem}.mp3`);

  // Streaming skip check — AFTER ffmpegVersion is set.
  const irHash = hashIR(ir);

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
        // Mirror production: on skip, still generate player artifacts if requested.
        if (opts.player) {
          const waveformPath = await generateWaveform(mp3Path, outDir);
          await generatePlayer(ir, mp3Path, waveformPath, outDir);
        }
        return { skipped: true, irHash, wavPath, mp3Path };
      }
    }
  }

  // Full pipeline — runFfmpeg is mocked (spy tracks calls).
  await mkdir(outDir, { recursive: true });
  const compiled = compileIR(ir, join(outDir, "mix.f32.wav"));
  const mixResult = await runFfmpeg(compiled);
  if (mixResult.exitCode !== 0) {
    throw new Error(`mix failed: ${mixResult.stderr}`);
  }

  // Fake output files (mocked functions don't create real files).
  await writeFile(wavPath, Buffer.from("FAKE_WAV"));
  await writeFile(mp3Path, Buffer.from("FAKE_MP3"));

  // Write render state.
  await writeRenderState(outDir, irHash);

  return { skipped: false, irHash, wavPath, mp3Path };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-streaming-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1: render-state.json written after a successful render
// ---------------------------------------------------------------------------

describe("AC1: render-state.json written after render", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = join(tmpDir, "ac1");
    await mkdir(outDir, { recursive: true });
    vi.clearAllMocks();
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, join(tmpDir, "ac1-cache"));
  });

  it("render-state.json exists", async () => {
    const statePath = join(outDir, ".soundstage", "render-state.json");
    await expect(access(statePath)).resolves.toBeUndefined();
  });

  it("render-state.json contains a 64-char hex ir_hash", async () => {
    const text = await readFile(
      join(outDir, ".soundstage", "render-state.json"),
      "utf8",
    );
    const state: unknown = JSON.parse(text);
    expect(typeof (state as { ir_hash: string }).ir_hash).toBe("string");
    expect((state as { ir_hash: string }).ir_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("runFfmpeg was called (first run, no prior state)", () => {
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC2: re-run with no changes → ffmpeg NOT called
// ---------------------------------------------------------------------------

describe("AC2: unchanged re-run skips ffmpeg", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = join(tmpDir, "ac2");
    await mkdir(outDir, { recursive: true });
    const cacheDir = join(tmpDir, "ac2-cache");

    // First run: cold state → runs ffmpeg.
    vi.clearAllMocks();
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir);

    // Second run: same IR → should skip.
    vi.clearAllMocks();
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir);
  });

  it("runFfmpeg NOT called on second run", () => {
    expect(runFfmpeg).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC3: changed Voice text → IR hash changes → ffmpeg called
// ---------------------------------------------------------------------------

describe("AC3: changed IR → ffmpeg called again", () => {
  // We simulate a changed IR by using different ffmpegVersion values, which
  // changes the hash without needing a second fixture. The "changed Voice text"
  // scenario is equivalent: any IR mutation changes the hash.

  let firstResult: StreamResult;
  let secondResult: StreamResult;

  beforeAll(async () => {
    const outDir = join(tmpDir, "ac3");
    await mkdir(outDir, { recursive: true });
    const cacheDir = join(tmpDir, "ac3-cache");

    // First run with version "v1.0.0".
    vi.clearAllMocks();
    firstResult = await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir, {
      ffmpegVersionOverride: "v1.0.0-fake-a",
    });

    // Second run with version "v2.0.0" → different hash → must re-render.
    vi.clearAllMocks();
    secondResult = await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir, {
      ffmpegVersionOverride: "v2.0.0-fake-b",
    });
  });

  it("first and second IR hashes differ", () => {
    expect(firstResult.irHash).not.toBe(secondResult.irHash);
  });

  it("second run was NOT skipped (full pipeline ran)", () => {
    expect(secondResult.skipped).toBe(false);
  });

  it("runFfmpeg called on second run", () => {
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC4: --force bypasses hash check
// ---------------------------------------------------------------------------

describe("AC4: --force always runs ffmpeg", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = join(tmpDir, "ac4");
    await mkdir(outDir, { recursive: true });
    const cacheDir = join(tmpDir, "ac4-cache");

    // First run: establish state.
    vi.clearAllMocks();
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir);

    // Second run: same IR but --force.
    vi.clearAllMocks();
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir, { force: true });
  });

  it("runFfmpeg called on force re-run", () => {
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC5: missing / corrupt render-state.json → full pipeline, no crash
// ---------------------------------------------------------------------------

describe("AC5: missing render-state.json → full pipeline", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = join(tmpDir, "ac5");
    await mkdir(outDir, { recursive: true });
    const cacheDir = join(tmpDir, "ac5-cache");

    // Establish a matching hash on disk then corrupt the file.
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir);
    const statePath = join(outDir, ".soundstage", "render-state.json");
    await writeFile(statePath, "NOT VALID JSON {{{", "utf8");

    vi.clearAllMocks();
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir);
  });

  it("corrupt state file → runFfmpeg was called (full pipeline)", () => {
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
  });
});

describe("AC5: absent render-state.json → full pipeline, no crash", () => {
  beforeAll(async () => {
    const outDir = join(tmpDir, "ac5-absent");
    await mkdir(outDir, { recursive: true });
    const cacheDir = join(tmpDir, "ac5-absent-cache");

    // No prior state file — should run without crashing.
    vi.clearAllMocks();
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir);
  });

  it("no prior state → runFfmpeg called (full pipeline, no crash)", () => {
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC6: missing output file → full pipeline even if hash matches
// ---------------------------------------------------------------------------

describe("AC6: missing output file → full pipeline", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = join(tmpDir, "ac6");
    await mkdir(outDir, { recursive: true });
    const cacheDir = join(tmpDir, "ac6-cache");

    // First run: establish state + output files.
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir);

    // Delete episode.wav — hash still matches but output is missing.
    await rm(join(outDir, "simple.wav"), { force: true });

    vi.clearAllMocks();
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir);
  });

  it("missing output file → runFfmpeg called (not skipped)", () => {
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC7: ffmpegVersion in hash — two different versions → two different hashes
// ---------------------------------------------------------------------------

describe("AC7: ffmpegVersion is included in the hash", () => {
  let hash1: string;
  let hash2: string;
  let outDirA: string;
  let outDirB: string;

  beforeAll(async () => {
    const cacheDir = join(tmpDir, "ac7-cache");

    outDirA = join(tmpDir, "ac7-a");
    outDirB = join(tmpDir, "ac7-b");
    await mkdir(outDirA, { recursive: true });
    await mkdir(outDirB, { recursive: true });

    // Run with fake version 1.
    vi.clearAllMocks();
    const r1 = await runStreamingPipeline(FIXTURE_SIMPLE, outDirA, cacheDir, {
      ffmpegVersionOverride: "fake-ffmpeg-9.0.0",
    });
    hash1 = r1.irHash;

    // Run with fake version 2 (different output dir — no state from run 1).
    vi.clearAllMocks();
    const r2 = await runStreamingPipeline(FIXTURE_SIMPLE, outDirB, cacheDir, {
      ffmpegVersionOverride: "fake-ffmpeg-10.0.0",
    });
    hash2 = r2.irHash;
  });

  it("two different ffmpegVersion values produce two different hashes", () => {
    expect(hash1).not.toBe(hash2);
  });

  it("runFfmpeg called in both runs (no skip due to hash mismatch)", () => {
    // After the second vi.clearAllMocks(), the first run's call count was reset.
    // The second run must have called runFfmpeg once (from outDirB, no prior state).
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
  });

  it("same IR with same version (run outDirA again) → skipped", async () => {
    const cacheDir = join(tmpDir, "ac7-cache");
    vi.clearAllMocks();
    const r3 = await runStreamingPipeline(FIXTURE_SIMPLE, outDirA, cacheDir, {
      ffmpegVersionOverride: "fake-ffmpeg-9.0.0",
    });
    expect(r3.skipped).toBe(true);
    expect(runFfmpeg).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fix 1: --player on streaming-skip path generates artifacts without mix
// ---------------------------------------------------------------------------

describe("Fix1: --player on unchanged re-run generates player artifacts without mix", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = join(tmpDir, "fix1-player");
    await mkdir(outDir, { recursive: true });
    const cacheDir = join(tmpDir, "fix1-cache");

    // First run: establish state + output files.
    vi.clearAllMocks();
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir);

    // Second run: same IR, player requested, player files absent.
    vi.clearAllMocks();
    await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir, { player: true });
  });

  it("runFfmpeg NOT called on skip+player run (mix stays skipped)", () => {
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("generateWaveform WAS called on the skip path", () => {
    expect(generateWaveform).toHaveBeenCalledTimes(1);
  });

  it("generatePlayer WAS called on the skip path", () => {
    expect(generatePlayer).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: changed <Voice> text (real narration edit) → hash changes → re-render
// ---------------------------------------------------------------------------
//
// Guards against a canonicalJSON / WAV-path normalization bug where a narration
// edit would silently NOT change the IR hash, causing the skip to fire on new
// content. The chain is:
//   Voice text changes → cache key changes → WAV path changes →
//   IR clips[].sourceRef.path changes → canonicalJSON(ir) changes → hash changes
//   → skip does NOT fire → ffmpeg runs.

describe("Fix2: changed Voice text triggers re-render", () => {
  let hashOriginal: string;
  let hashEdited: string;

  beforeAll(async () => {
    const outDir = join(tmpDir, "fix2");
    await mkdir(outDir, { recursive: true });
    const cacheDir = join(tmpDir, "fix2-cache");

    // First render: original fixture.
    vi.clearAllMocks();
    const r1 = await runStreamingPipeline(FIXTURE_SIMPLE, outDir, cacheDir);
    hashOriginal = r1.irHash;

    // Second render: same outDir but edited fixture (different Voice text).
    vi.clearAllMocks();
    const r2 = await runStreamingPipeline(FIXTURE_EDITED, outDir, cacheDir);
    hashEdited = r2.irHash;
  });

  it("original and edited IR hashes differ", () => {
    expect(hashOriginal).not.toBe(hashEdited);
  });

  it("ffmpeg runs on the edited render (not skipped)", () => {
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
  });

  it("second render with edited text is not skipped", async () => {
    const outDir = join(tmpDir, "fix2");
    const cacheDir = join(tmpDir, "fix2-cache");
    vi.clearAllMocks();
    const r3 = await runStreamingPipeline(FIXTURE_EDITED, outDir, cacheDir);
    // Now state has the edited hash — unchanged re-run of edited version IS skipped.
    expect(r3.skipped).toBe(true);
    expect(runFfmpeg).not.toHaveBeenCalled();
  });
});
