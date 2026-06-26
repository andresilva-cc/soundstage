// Binary CLI integration tests for `soundstage feed` (FIX 4).
// Runs the built binary via child_process to verify real exit codes.
// Mirrors the runCli helper from cli-binary.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, extname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const WORKTREE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI_ENTRY = join(WORKTREE_ROOT, "dist", "cli", "index.js");
const FIXTURE_SIMPLE = join(WORKTREE_ROOT, "test", "fixtures", "episodes", "simple.tsx");
const distExists = existsSync(CLI_ENTRY);

// ---------------------------------------------------------------------------
// runCli helper (mirrors cli-binary.test.ts)
// ---------------------------------------------------------------------------

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { encoding: "utf8", timeout: 60_000 },
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
// Render an mp3 via the synthetic adapter (hermetic)
// ---------------------------------------------------------------------------

async function renderMp3(fixturePath: string, outDir: string): Promise<string> {
  const absFile = resolve(fixturePath);
  const fileBaseDir = dirname(absFile);
  const stem = basename(absFile, extname(absFile));

  const cacheDirPath = join(outDir, ".soundstage", "cache");
  await mkdir(cacheDirPath, { recursive: true });

  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDirPath, { noCache: false });
  function onVoiceSynthesized(): void {}

  const tree = await loadTsx(absFile);
  const resolvedTree = await phaseA(tree, { cache, baseDir: fileBaseDir, onVoiceSynthesized });
  const ir = phaseB(resolvedTree);
  const ffmpegVersion = await getFfmpegVersion();
  ir.render.ffmpegVersion = ffmpegVersion;
  ir.render.outputs = ["wav", "mp3"];

  const wavPath = join(outDir, `${stem}.wav`);
  const mp3Path = join(outDir, `${stem}.mp3`);

  const tmpRenderDir = await mkdtemp(join(tmpdir(), "soundstage-feed-bin-"));
  try {
    const mixPath = join(tmpRenderDir, "mix.f32.wav");
    const compiled = compileIR(ir, mixPath);
    const mixResult = await runFfmpeg(compiled);
    if (mixResult.exitCode !== 0) throw new Error(`Mix failed: ${mixResult.stderr}`);
    await applyLoudnorm(mixPath, ir.loudness, ir.sampleRate, wavPath);
    await encodeMp3(wavPath, mp3Path);
    await runChapterPostPass(ir, mp3Path, wavPath);
  } finally {
    await rm(tmpRenderDir, { recursive: true, force: true });
  }

  return mp3Path;
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tmpDir: string;
let mp3Path: string;
let validConfigPath: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-feed-bin-root-"));
  const renderDir = join(tmpDir, "render");
  await mkdir(renderDir, { recursive: true });

  mp3Path = await renderMp3(FIXTURE_SIMPLE, renderDir);

  const feedConfig = {
    show: {
      title: "Binary Test Podcast",
      description: "CLI binary test",
      author: "Test",
      email: "test@example.com",
      imageUrl: "https://example.com/cover.jpg",
      category: "Technology",
      language: "en-us",
      baseUrl: "https://example.com/episodes/",
      feedUrl: "https://example.com/feed.xml",
      link: "https://example.com",
      explicit: false,
    },
    episodes: [
      {
        file: mp3Path,
        title: "Episode 1",
        pubDate: "2026-06-01T00:00:00Z",
        guid: "ep1-2026-06-01",
      },
    ],
  };

  validConfigPath = join(tmpDir, "soundstage-feed.json");
  await writeFile(validConfigPath, JSON.stringify(feedConfig, null, 2));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)("soundstage feed — binary CLI exit codes", () => {
  it("exits 0 and writes feed.xml on a valid config", async () => {
    const outDir = join(tmpDir, "out-success");
    await mkdir(outDir, { recursive: true });
    const result = await runCli(["feed", "--config", validConfigPath, "--out", outDir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("feed → feed.xml");
    const feedContent = await readFile(join(outDir, "feed.xml"), "utf8");
    expect(feedContent).toContain("<?xml");
  });

  it("exits 1 when config file does not exist", async () => {
    const result = await runCli(["feed", "--config", join(tmpDir, "nonexistent.json")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not found|unreadable/i);
  });

  it("exits 1 when config is malformed (missing required field)", async () => {
    const badConfig = { show: { title: "Only title" }, episodes: [] };
    const badConfigPath = join(tmpDir, "bad-feed.json");
    await writeFile(badConfigPath, JSON.stringify(badConfig));
    const result = await runCli(["feed", "--config", badConfigPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/description|imageUrl|feedUrl|author|category|language|baseUrl/i);
  });

  it("exits 1 when episode mp3 file does not exist", async () => {
    const missingMp3Config = {
      show: {
        title: "Podcast",
        description: "Desc",
        author: "Author",
        email: "test@example.com",
        imageUrl: "https://example.com/cover.jpg",
        category: "Technology",
        language: "en-us",
        baseUrl: "https://example.com/episodes/",
        feedUrl: "https://example.com/feed.xml",
        explicit: false,
      },
      episodes: [
        {
          file: "/nonexistent/path/episode.mp3",
          title: "Missing Episode",
          pubDate: "2026-06-01T00:00:00Z",
          guid: "missing-ep-1",
        },
      ],
    };
    const missingMp3ConfigPath = join(tmpDir, "missing-mp3-feed.json");
    await writeFile(missingMp3ConfigPath, JSON.stringify(missingMp3Config));
    const result = await runCli(["feed", "--config", missingMp3ConfigPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not found|mp3/i);
  });
});
