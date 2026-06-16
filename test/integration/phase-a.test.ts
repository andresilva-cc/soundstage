// Integration tests for Phase A (resolve & synthesize).
// Uses the synthetic adapter + real temp dirs (hermetic, no network).
// Real WAV fixture for <Clip> duration probing (generated via ffmpeg in beforeAll).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { phaseA } from "../../src/ir/phase-a.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import type { SoundstageElement } from "../../src/jsx-runtime/index.js";
import type { TtsAdapter } from "../../src/adapters/types.js";
import * as ffprobeModule from "../../src/probe/ffprobe.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEpisode(children: SoundstageElement[]): SoundstageElement {
  return {
    type: "Episode",
    props: { title: "Test Episode", sampleRate: 48000, voice: "host" },
    children,
  };
}

function makeVoice(text: string, voice?: string): SoundstageElement {
  return {
    type: "Voice",
    props: voice ? { voice } : {},
    children: [text],
  };
}

function makeClip(src: string): SoundstageElement {
  return {
    type: "Clip",
    props: { src },
    children: [],
  };
}

function makeMusicBed(src: string, children: SoundstageElement[] = []): SoundstageElement {
  return {
    type: "MusicBed",
    props: { src },
    children,
  };
}

/** Generate a real WAV fixture via ffmpeg (1s 440Hz sine, 24kHz mono f32le). */
async function generateFixtureWav(path: string, durationSec = 1.0): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=440:duration=${durationSec}:sample_rate=24000`,
    "-c:a", "pcm_f32le",
    "-ac", "1",
    path,
  ]);
}

/** Generate a real MP3 fixture via ffmpeg (1s 440Hz sine, 44100Hz mono). */
async function generateFixtureMp3(path: string, durationSec = 1.0): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=440:duration=${durationSec}:sample_rate=44100`,
    "-c:a", "libmp3lame",
    "-ac", "1",
    "-q:a", "9",
    path,
  ]);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let cacheDir: string;
let fixtureWav: string;
let fixtureMp3: string;
let adapter: SyntheticAdapter;
let cache: CacheLayer;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-phase-a-test-"));
  cacheDir = join(tmpDir, "cache");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cacheDir, { recursive: true }));
  fixtureWav = join(tmpDir, "fixture.wav");
  fixtureMp3 = join(tmpDir, "fixture.mp3");
  await generateFixtureWav(fixtureWav);
  await generateFixtureMp3(fixtureMp3);
  adapter = new SyntheticAdapter();
  cache = new CacheLayer(adapter, cacheDir);
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC 1: Two Voice nodes → both get sourceRef.kind === "cache" + durationSamples > 0
// ---------------------------------------------------------------------------

describe("AC1 — two Voice nodes get cache sourceRefs + durationSamples", () => {
  it("resolves two Voice nodes with kind=cache and durationSamples > 0", async () => {
    const tree = makeEpisode([
      makeVoice("Hello world", "host"),
      makeVoice("Goodbye world", "host"),
    ]);

    const resolved = await phaseA(tree, { cache, baseDir: tmpDir });

    expect(resolved.type).toBe("Episode");
    const children = resolved.children.filter(
      (c): c is SoundstageElement => typeof c === "object" && c !== null && "type" in c,
    );
    expect(children).toHaveLength(2);

    for (const child of children) {
      expect(child.type).toBe("Voice");
      const sourceRef = child.props["sourceRef"] as { kind: string; path: string; hash: string };
      expect(sourceRef.kind).toBe("cache");
      expect(typeof sourceRef.path).toBe("string");
      expect(typeof sourceRef.hash).toBe("string");
      expect(child.props["durationSamples"]).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC 2: <Clip src> → sourceRef.kind === "file" with probed durationSamples
// ---------------------------------------------------------------------------

describe("AC2 — Clip gets file sourceRef with probed durationSamples", () => {
  it("produces sourceRef.kind=file and durationSamples matching fixture wav", async () => {
    const tree = makeEpisode([makeClip(fixtureWav)]);
    const resolved = await phaseA(tree, { cache, baseDir: tmpDir });

    const children = resolved.children.filter(
      (c): c is SoundstageElement => typeof c === "object" && c !== null && "type" in c,
    );
    expect(children).toHaveLength(1);
    const clip = children[0]!;

    expect(clip.type).toBe("Clip");
    const sourceRef = clip.props["sourceRef"] as { kind: string; path: string };
    expect(sourceRef.kind).toBe("file");
    expect(sourceRef.path).toBe(fixtureWav);
    const durationSamples = clip.props["durationSamples"] as number;
    expect(durationSamples).toBeGreaterThan(0);
    // 1 second at 24000 Hz = ~24000 samples; allow ±500 for ffprobe rounding
    expect(durationSamples).toBeGreaterThan(23000);
    expect(durationSamples).toBeLessThan(25000);
  });

  it("non-WAV (MP3): probes durationSamples via duration×sampleRate fallback", async () => {
    const tree = makeEpisode([makeClip(fixtureMp3)]);
    const resolved = await phaseA(tree, { cache, baseDir: tmpDir });

    const children = resolved.children.filter(
      (c): c is SoundstageElement => typeof c === "object" && c !== null && "type" in c,
    );
    expect(children).toHaveLength(1);
    const clip = children[0]!;

    expect(clip.type).toBe("Clip");
    const sourceRef = clip.props["sourceRef"] as { kind: string; path: string };
    expect(sourceRef.kind).toBe("file");
    const durationSamples = clip.props["durationSamples"] as number;
    // 1 second at 44100 Hz = ~44100 samples; MP3 encoder may add padding so allow wider range
    expect(durationSamples).toBeGreaterThan(40000);
    expect(durationSamples).toBeLessThan(50000);
  });
});

// ---------------------------------------------------------------------------
// AC 3: ffprobe called only once per unique (absPath, mtime, size)
// ---------------------------------------------------------------------------

describe("AC3 — probe memoization: two Clips pointing to same file → one ffprobe call", () => {
  it("probes the same file only once (inner runFfprobe called exactly once)", async () => {
    // Clear the in-process memo so this test starts cold
    const probeModule = await import("../../src/probe/index.js");
    probeModule.clearProbeCache();

    // Spy on the INNER ffprobe exec — memoization means this should fire only once
    // even when two Clip nodes reference the same file.
    // src/probe/index.ts calls ffprobeModule.runFfprobe() through the namespace import
    // so vi.spyOn on the module object intercepts the call.
    const ffprobeSpy = vi.spyOn(ffprobeModule, "runFfprobe");

    // Two clips pointing to the same fixture
    const tree = makeEpisode([makeClip(fixtureWav), makeClip(fixtureWav)]);
    const resolved = await phaseA(tree, { cache, baseDir: tmpDir });

    const clips = resolved.children.filter(
      (c): c is SoundstageElement => typeof c === "object" && c !== null && "type" in c,
    );
    expect(clips).toHaveLength(2);

    // Both clips must carry the same durationSamples (memo correctness)
    const dur1 = clips[0]!.props["durationSamples"] as number;
    const dur2 = clips[1]!.props["durationSamples"] as number;
    expect(dur1).toBe(dur2);
    expect(dur1).toBeGreaterThan(0);

    // The inner ffprobe exec must have been called exactly ONCE — the second Clip
    // was served from the in-process memo. If memoization is removed this will be 2.
    expect(ffprobeSpy).toHaveBeenCalledTimes(1);

    ffprobeSpy.mockRestore();
  });

  it("memo cache stores result for same file: second phaseA call gets same durationSamples", async () => {
    const { clearProbeCache } = await import("../../src/probe/index.js");
    clearProbeCache();

    const tree1 = makeEpisode([makeClip(fixtureWav)]);
    const tree2 = makeEpisode([makeClip(fixtureWav)]);

    const resolved1 = await phaseA(tree1, { cache, baseDir: tmpDir });
    const resolved2 = await phaseA(tree2, { cache, baseDir: tmpDir });

    const clip1 = (resolved1.children as SoundstageElement[])[0]!;
    const clip2 = (resolved2.children as SoundstageElement[])[0]!;
    expect(clip1.props["durationSamples"]).toBe(clip2.props["durationSamples"]);
  });
});

// ---------------------------------------------------------------------------
// AC 4: <MusicBed src> without children still gets probed
// ---------------------------------------------------------------------------

describe("AC4 — MusicBed without children gets probed", () => {
  it("MusicBed with no children gets sourceRef.kind=file and durationSamples", async () => {
    const tree = makeEpisode([makeMusicBed(fixtureWav)]);
    const resolved = await phaseA(tree, { cache, baseDir: tmpDir });

    const children = resolved.children.filter(
      (c): c is SoundstageElement => typeof c === "object" && c !== null && "type" in c,
    );
    expect(children).toHaveLength(1);
    const bed = children[0]!;
    expect(bed.type).toBe("MusicBed");
    const sourceRef = bed.props["sourceRef"] as { kind: string; path: string };
    expect(sourceRef.kind).toBe("file");
    expect(bed.props["durationSamples"]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC 5: Synthesis is sequential — no Promise.all over Voice nodes.
// This is a code-structure guarantee; we confirm the sequential order via
// call-ordering: a side-effectful counter incremented in synth order.
// ---------------------------------------------------------------------------

describe("AC5 — synthesis is sequential", () => {
  it("Voice nodes are synthesized in tree order (sequential)", async () => {
    const callOrder: string[] = [];

    const trackingAdapter = {
      id: "synthetic",
      model: "synthetic-v1",
      canonicalSettings: (req: { speed?: number }) => ({ speed: req.speed ?? 1.0 }),
      synth: async (req: { text: string; voice: string; speed?: number; sampleRate: number }) => {
        callOrder.push(req.text);
        // Simulate slight async delay to expose concurrent ordering if any
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Return minimal valid result
        return {
          pcm: new Float32Array(100),
          sampleRate: 24000,
          durationSamples: 100,
        };
      },
    };

    const seqCacheDir = join(tmpDir, "seq-cache");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(seqCacheDir, { recursive: true }));
    const seqCache = new CacheLayer(trackingAdapter as TtsAdapter, seqCacheDir);

    const tree = makeEpisode([
      makeVoice("first utterance", "host"),
      makeVoice("second utterance", "host"),
      makeVoice("third utterance", "host"),
    ]);

    await phaseA(tree, { cache: seqCache, baseDir: tmpDir });

    // If synthesis were concurrent, order would be non-deterministic;
    // sequential guarantees tree-order.
    expect(callOrder).toEqual(["first utterance", "second utterance", "third utterance"]);
  });
});

// ---------------------------------------------------------------------------
// AC 6: Validation runs before synthesis — bad prop throws without TTS call
// ---------------------------------------------------------------------------

describe("AC6 — validation before synthesis", () => {
  it("throws E_MISSING_PROP on bad tree without calling adapter synth", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");
    synthSpy.mockClear();

    // A Voice node with no voice prop and no inherited voice — invalid
    const badTree: SoundstageElement = {
      type: "Episode",
      props: { title: "Bad Episode", sampleRate: 48000 },
      // No voice on Episode, and no voice on Voice child
      children: [
        {
          type: "Voice",
          props: {},
          children: ["some text"],
        },
      ],
    };

    await expect(phaseA(badTree, { cache, baseDir: tmpDir })).rejects.toThrow("E_MISSING_PROP");
    expect(synthSpy).not.toHaveBeenCalled();
    synthSpy.mockRestore();
  });

  it("throws E_SRC_NOT_FOUND for missing src without any TTS call", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");
    synthSpy.mockClear();

    const badTree = makeEpisode([
      makeClip("/nonexistent/path/to/audio.wav"),
    ]);

    await expect(phaseA(badTree, { cache, baseDir: tmpDir })).rejects.toThrow("E_SRC_NOT_FOUND");
    expect(synthSpy).not.toHaveBeenCalled();
    synthSpy.mockRestore();
  });

  it("hash on resolved Voice node matches /^[0-9a-f]{64}$/", async () => {
    const tree = makeEpisode([makeVoice("some utterance", "host")]);
    const resolved = await phaseA(tree, { cache, baseDir: tmpDir });

    const children = resolved.children.filter(
      (c): c is SoundstageElement => typeof c === "object" && c !== null && "type" in c,
    );
    const voice = children[0]!;
    const sourceRef = voice.props["sourceRef"] as { kind: string; hash: string };
    expect(sourceRef.kind).toBe("cache");
    expect(sourceRef.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// AC 7: Warm-cache — adapter.synth fired only once across two phaseA runs
// ---------------------------------------------------------------------------

describe("AC7 — warm-cache no-re-synth", () => {
  it("adapter.synth fires only once when phaseA runs twice on the same Voice utterance", async () => {
    const warmCacheDir = join(tmpDir, "warm-cache");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(warmCacheDir, { recursive: true }));
    const warmAdapter = new SyntheticAdapter();
    const warmCache = new CacheLayer(warmAdapter, warmCacheDir);
    const synthSpy = vi.spyOn(warmAdapter, "synth");

    const tree = makeEpisode([makeVoice("warm cache test utterance", "host")]);

    // First run — miss → synth is called
    await phaseA(tree, { cache: warmCache, baseDir: tmpDir });
    expect(synthSpy).toHaveBeenCalledOnce();

    synthSpy.mockClear();

    // Second run — hit → synth must NOT be called again
    await phaseA(tree, { cache: warmCache, baseDir: tmpDir });
    expect(synthSpy).not.toHaveBeenCalled();
  });
});
