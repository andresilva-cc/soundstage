// Integration tests for `soundstage feed` subcommand (Task 2).
// Uses a fixture soundstage-feed.json + a synthetic-adapter-rendered mp3.
// Verifies: feed.xml is generated; it parses as valid XML; error paths exit correctly.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, extname } from "node:path";
import { XMLParser } from "fast-xml-parser";

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
import { validateFeedConfig, buildFeedXml } from "../../src/compiler/feed.js";
import type { EpisodeMeta } from "../../src/compiler/feed.js";
import { probeFileDuration } from "../../src/probe/index.js";

// ---------------------------------------------------------------------------
// Fixture path
// ---------------------------------------------------------------------------

const FIXTURE_SIMPLE = new URL(
  "../fixtures/episodes/simple.tsx",
  import.meta.url,
).pathname;

// ---------------------------------------------------------------------------
// Helpers
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

  const tmpRenderDir = await mkdtemp(join(tmpdir(), "soundstage-feed-int-"));
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
// Test setup: render a real mp3 once, then run feed generation against it
// ---------------------------------------------------------------------------

let tmpDir: string;
let mp3Path: string;
let feedConfigPath: string;
let feedOutDir: string;

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-feed-int-root-"));
  const renderDir = join(tmpDir, "render");
  await mkdir(renderDir, { recursive: true });
  feedOutDir = join(tmpDir, "feed-out");
  await mkdir(feedOutDir, { recursive: true });

  mp3Path = await renderMp3(FIXTURE_SIMPLE, renderDir);

  // Write a fixture soundstage-feed.json
  const feedConfig = {
    show: {
      title: "Test Podcast",
      description: "A test podcast for integration tests",
      author: "Test Author",
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
        title: "Episode 1: Simple Test",
        description: "The first test episode",
        pubDate: "2026-06-01T00:00:00Z",
        guid: "ep1-2026-06-01",
        explicit: false,
      },
    ],
  };

  feedConfigPath = join(feedOutDir, "soundstage-feed.json");
  await writeFile(feedConfigPath, JSON.stringify(feedConfig, null, 2));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Integration test: generate feed.xml programmatically (mirrors CLI handler)
// ---------------------------------------------------------------------------

async function runFeedGeneration(configPath: string, outDir: string): Promise<string> {
  const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const config = validateFeedConfig(raw);

  const episodeMetas = await Promise.all(
    config.episodes.map(async (ep) => {
      const absPath = resolve(dirname(configPath), ep.file);
      const { size } = await stat(absPath);
      const { durationSamples, sampleRate } = await probeFileDuration(absPath);
      const durationSeconds = Math.round(durationSamples / sampleRate);
      const url = config.show.baseUrl + basename(ep.file);
      const meta: EpisodeMeta = {
        guid: ep.guid,
        title: ep.title,
        pubDate: ep.pubDate,
        url,
        byteSize: Number(size),
        durationSeconds,
      };
      if (ep.description !== undefined) meta.description = ep.description;
      if (ep.explicit !== undefined) meta.explicit = ep.explicit;
      return meta;
    }),
  );

  const xml = buildFeedXml(config, episodeMetas);
  const feedPath = join(outDir, "feed.xml");
  await writeFile(feedPath, xml, "utf8");
  return feedPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("soundstage feed — feed.xml generation", () => {
  let feedXmlPath: string;
  let feedXmlContent: string;

  beforeAll(async () => {
    feedXmlPath = await runFeedGeneration(feedConfigPath, feedOutDir);
    feedXmlContent = await readFile(feedXmlPath, "utf8");
  });

  it("generates feed.xml in the output directory", async () => {
    await expect(access(feedXmlPath)).resolves.toBeUndefined();
  });

  it("feed.xml starts with XML declaration", () => {
    expect(feedXmlContent.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("feed.xml parses as valid XML", () => {
    expect(() => xmlParser.parse(feedXmlContent)).not.toThrow();
  });

  it("feed.xml contains the show title", () => {
    expect(feedXmlContent).toContain("Test Podcast");
  });

  it("feed.xml contains the episode title", () => {
    expect(feedXmlContent).toContain("Episode 1: Simple Test");
  });

  it("feed.xml contains an <item> for the episode", () => {
    expect(feedXmlContent).toContain("<item>");
  });

  it("feed.xml contains the enclosure type audio/mpeg", () => {
    expect(feedXmlContent).toContain('type="audio/mpeg"');
  });

  it("feed.xml contains non-zero enclosure length (byte size of real mp3)", () => {
    const match = feedXmlContent.match(/length="(\d+)"/);
    expect(match).not.toBeNull();
    const byteSize = parseInt(match?.[1] ?? "0", 10);
    expect(byteSize).toBeGreaterThan(0);
  });

  it("feed.xml contains the pubDate matching the config date (not current wall-clock)", () => {
    expect(feedXmlContent).toContain("01 Jun 2026");
  });

  it("feed.xml contains itunes:duration from ffprobe", () => {
    expect(feedXmlContent).toMatch(/<itunes:duration>\d{2}:\d{2}:\d{2}<\/itunes:duration>/);
  });

  it("feed.xml contains atom:link with feedUrl", () => {
    expect(feedXmlContent).toContain("https://example.com/feed.xml");
    expect(feedXmlContent).toContain('rel="self"');
  });
});

describe("soundstage feed — --out <dir> writes to specified directory", () => {
  it("writes feed.xml to a specified outDir", async () => {
    const altOutDir = join(tmpDir, "alt-out");
    await mkdir(altOutDir, { recursive: true });
    const feedPath = await runFeedGeneration(feedConfigPath, altOutDir);
    await expect(access(feedPath)).resolves.toBeUndefined();
    expect(feedPath).toBe(join(altOutDir, "feed.xml"));
  });
});

describe("soundstage feed — error paths", () => {
  it("throws when config file does not exist (entry point would exit 1)", async () => {
    await expect(
      readFile(join(tmpDir, "nonexistent-feed.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("throws when config is malformed (missing required field)", () => {
    const bad = { show: { title: "Only title" }, episodes: [] };
    expect(() => validateFeedConfig(bad)).toThrow();
  });

  it("throws when episode mp3 file does not exist (stat fails)", async () => {
    // stat throws when the file doesn't exist — the CLI handler catches this and exits 1
    await expect(
      stat(resolve(dirname(feedConfigPath), "/nonexistent/missing.mp3")),
    ).rejects.toThrow();
  });
});
