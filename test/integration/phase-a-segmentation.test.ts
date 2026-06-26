// Integration tests for Phase A multi-chunk synthesis (Task 7).
// Verifies that segment() is applied per Voice, cache.get() is called once per chunk,
// and the onVoiceSynthesized callback fires once per chunk.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phaseA } from "../../src/ir/phase-a.js";
import type { ChunkResult } from "../../src/ir/phase-a.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import type { SoundstageElement } from "../../src/jsx-runtime/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEpisode(children: SoundstageElement[]): SoundstageElement {
  return {
    type: "Episode",
    props: { title: "Segmentation Test", sampleRate: 48000, voice: "host" },
    children,
  };
}

function makeVoice(text: string): SoundstageElement {
  return {
    type: "Voice",
    props: { voice: "host" },
    children: [text],
  };
}

// ---------------------------------------------------------------------------
// Three-sentence text (all sentences ≥ 40 chars → 3 chunks)
// ---------------------------------------------------------------------------

const THREE_SENTENCE_TEXT = [
  "This is the first sentence which has enough characters to qualify.",
  "And here is the second sentence also with sufficient length.",
  "The third sentence completes this multi-chunk voice example.",
].join(" ");

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let cacheDir: string;
let adapter: SyntheticAdapter;
let cache: CacheLayer;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-phaseA-seg-test-"));
  cacheDir = join(tmpDir, "cache");
  await mkdir(cacheDir, { recursive: true });
  adapter = new SyntheticAdapter();
  cache = new CacheLayer(adapter, cacheDir);
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC: 3-sentence Voice calls cache.get() exactly 3 times
// ---------------------------------------------------------------------------

describe("Phase A segmentation — 3-sentence Voice", () => {
  it("calls cache.get() exactly 3 times for a 3-sentence Voice", async () => {
    const synthDir = join(tmpDir, "cache-spy");
    await mkdir(synthDir, { recursive: true });
    const spyAdapter = new SyntheticAdapter();
    const spyCache = new CacheLayer(spyAdapter, synthDir);
    const getSpy = vi.spyOn(spyCache, "get");

    const tree = makeEpisode([makeVoice(THREE_SENTENCE_TEXT)]);
    await phaseA(tree, { cache: spyCache, baseDir: tmpDir });

    expect(getSpy).toHaveBeenCalledTimes(3);

    getSpy.mockRestore();
  });

  it("produces a resolved Voice node with chunks.length === 3", async () => {
    const tree = makeEpisode([makeVoice(THREE_SENTENCE_TEXT)]);
    const resolved = await phaseA(tree, { cache, baseDir: tmpDir });

    const children = resolved.children.filter(
      (c): c is SoundstageElement => typeof c === "object" && c !== null && "type" in c,
    );
    expect(children).toHaveLength(1);
    const voice = children[0]!;
    const chunks = voice.props["chunks"] as ChunkResult[];
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks).toHaveLength(3);
  });

  it("all 3 chunks in the resolved node share the same voiceUnitId", async () => {
    const tree = makeEpisode([makeVoice(THREE_SENTENCE_TEXT)]);
    const resolved = await phaseA(tree, { cache, baseDir: tmpDir });

    const children = resolved.children.filter(
      (c): c is SoundstageElement => typeof c === "object" && c !== null && "type" in c,
    );
    const voice = children[0]!;
    const voiceUnitId = voice.props["voiceUnitId"] as number;
    const chunks = voice.props["chunks"] as ChunkResult[];

    // voiceUnitId is stored on the node, not per-chunk
    expect(typeof voiceUnitId).toBe("number");
    // All chunks belong to this single Voice node → same voiceUnitId
    expect(chunks).toHaveLength(3);
    // chunks' hash/wavPath/durationSamples should all be populated
    for (const chunk of chunks) {
      expect(typeof chunk.wavPath).toBe("string");
      expect(chunk.wavPath.length).toBeGreaterThan(0);
      expect(typeof chunk.hash).toBe("string");
      expect(chunk.hash.length).toBeGreaterThan(0);
      expect(chunk.durationSamples).toBeGreaterThan(0);
    }
  });

  it("onVoiceSynthesized is called 3 times with chunkIndex 0, 1, 2 and chunkTotal=3", async () => {
    const spyDir = join(tmpDir, "cb-spy-cache");
    await mkdir(spyDir, { recursive: true });
    const cbAdapter = new SyntheticAdapter();
    const cbCache = new CacheLayer(cbAdapter, spyDir);

    const calls: Array<{ voiceUnitId: number; chunkIndex: number; chunkTotal: number; hit: boolean }> = [];
    function onVoiceSynthesized(voiceUnitId: number, chunkIndex: number, chunkTotal: number, hit: boolean): void {
      calls.push({ voiceUnitId, chunkIndex, chunkTotal, hit });
    }

    const tree = makeEpisode([makeVoice(THREE_SENTENCE_TEXT)]);
    await phaseA(tree, { cache: cbCache, baseDir: tmpDir, onVoiceSynthesized });

    expect(calls).toHaveLength(3);
    expect(calls[0]!.chunkIndex).toBe(0);
    expect(calls[1]!.chunkIndex).toBe(1);
    expect(calls[2]!.chunkIndex).toBe(2);
    for (const call of calls) {
      expect(call.chunkTotal).toBe(3);
      expect(call.voiceUnitId).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC: single-sentence Voice → 1 chunk (identical to pre-T7 behavior, modulo schema)
// ---------------------------------------------------------------------------

describe("Phase A segmentation — single-sentence Voice", () => {
  it("single-sentence Voice produces exactly 1 chunk", async () => {
    const singleDir = join(tmpDir, "single-cache");
    await mkdir(singleDir, { recursive: true });
    const singleCache = new CacheLayer(new SyntheticAdapter(), singleDir);

    const tree = makeEpisode([makeVoice("Hello world.")]);
    const resolved = await phaseA(tree, { cache: singleCache, baseDir: tmpDir });

    const children = resolved.children.filter(
      (c): c is SoundstageElement => typeof c === "object" && c !== null && "type" in c,
    );
    const voice = children[0]!;
    const chunks = voice.props["chunks"] as ChunkResult[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.durationSamples).toBeGreaterThan(0);
  });

  it("onVoiceSynthesized called once with chunkIndex=0, chunkTotal=1 for single-sentence", async () => {
    const oneDir = join(tmpDir, "one-cb-cache");
    await mkdir(oneDir, { recursive: true });
    const oneCache = new CacheLayer(new SyntheticAdapter(), oneDir);

    const calls: Array<{ chunkIndex: number; chunkTotal: number }> = [];
    function onVoiceSynthesized(_v: number, chunkIndex: number, chunkTotal: number, _h: boolean): void {
      calls.push({ chunkIndex, chunkTotal });
    }

    const tree = makeEpisode([makeVoice("Hello world.")]);
    await phaseA(tree, { cache: oneCache, baseDir: tmpDir, onVoiceSynthesized });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.chunkIndex).toBe(0);
    expect(calls[0]!.chunkTotal).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC: ChunkResult type shape
// ---------------------------------------------------------------------------

describe("ChunkResult type shape", () => {
  it("ChunkResult has expected fields: wavPath, durationSamples, sampleRate, hash, hit", async () => {
    const typeDir = join(tmpDir, "type-cache");
    await mkdir(typeDir, { recursive: true });
    const typeCache = new CacheLayer(new SyntheticAdapter(), typeDir);

    const tree = makeEpisode([makeVoice("Hello world.")]);
    const resolved = await phaseA(tree, { cache: typeCache, baseDir: tmpDir });

    const children = resolved.children.filter(
      (c): c is SoundstageElement => typeof c === "object" && c !== null && "type" in c,
    );
    const voice = children[0]!;
    const chunks = voice.props["chunks"] as ChunkResult[];
    const chunk = chunks[0]!;

    expect(typeof chunk.wavPath).toBe("string");
    expect(typeof chunk.durationSamples).toBe("number");
    expect(typeof chunk.sampleRate).toBe("number");
    expect(typeof chunk.hash).toBe("string");
    expect(typeof chunk.hit).toBe("boolean");
  });

  it("chunk.durationSamples is at master rate (scaled from native 24kHz to 48kHz)", async () => {
    const rateDir = join(tmpDir, "rate-cache");
    await mkdir(rateDir, { recursive: true });

    let nativeDuration: number | null = null;
    const capturingAdapter = new SyntheticAdapter();
    const origSynth = capturingAdapter.synth.bind(capturingAdapter);
    capturingAdapter.synth = async (req) => {
      const result = await origSynth(req);
      nativeDuration = result.durationSamples;
      return result;
    };

    const rateCache = new CacheLayer(capturingAdapter, rateDir);
    const tree = makeEpisode([makeVoice("Hello world.")]);
    const resolved = await phaseA(tree, { cache: rateCache, baseDir: tmpDir });

    expect(nativeDuration).not.toBeNull();

    const children = resolved.children.filter(
      (c): c is SoundstageElement => typeof c === "object" && c !== null && "type" in c,
    );
    const voice = children[0]!;
    const chunks = voice.props["chunks"] as ChunkResult[];
    const chunk = chunks[0]!;

    // chunk.durationSamples should be at master rate (48000), not native (24000)
    const expected = Math.round(nativeDuration! * 48000 / 24000);
    expect(chunk.durationSamples).toBe(expected);
  });
});
