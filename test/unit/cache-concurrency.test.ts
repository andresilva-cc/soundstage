// Unit tests for Task 11: Cache Concurrency + Write Hardening (Issue #22)
// + review-fix-pass covering the cross-process EEXIST race and coverage gaps.
//
// vi.mock wraps writeFile, access, and readFile in vi.fn so tests can queue
// one-shot mock implementations without affecting unrelated calls.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type * as NodeFsPromises from "node:fs/promises";

// vi.mock is hoisted by vitest — runs before any imports below.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    access: vi.fn(actual.access),
    readFile: vi.fn(actual.readFile),
  };
});

import { mkdtemp, rm, writeFile, access, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SoundstageError } from "../../src/ir/errors.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import { deriveKey } from "../../src/adapters/cache/key.js";
import type { SynthRequest } from "../../src/adapters/types.js";

function baseReq(overrides: Partial<SynthRequest> = {}): SynthRequest {
  return { text: "concurrent test", voice: "host", sampleRate: 24000, ...overrides };
}

/** Cast to access the private pendingMisses map for assertions. */
function pendingMissesMap(c: CacheLayer): Map<string, unknown> {
  return (c as unknown as { pendingMisses: Map<string, unknown> }).pendingMisses;
}

/** Minimal valid sidecar a "concurrent winner" would write. */
const WINNER_SIDECAR = {
  durationSamples: 12000,
  sampleRate: 24000,
  sampleFmt: "f32le",
  channels: 1,
  ffprobeVersion: "ffprobe version 7.1",
  adapterId: "synthetic",
  model: "synthetic-v1",
  createdAt: new Date().toISOString(),
};

let tmpDir: string;
let adapter: SyntheticAdapter;
let cache: CacheLayer;

beforeEach(async () => {
  vi.clearAllMocks(); // reset call counts; vi.fn(actual.*) implementations are preserved
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-concurrency-test-"));
  adapter = new SyntheticAdapter();
  cache = new CacheLayer(adapter, tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Concurrent miss deduplication (in-process promise map)
// ---------------------------------------------------------------------------

describe("CacheLayer — concurrent miss deduplication (promise map)", () => {
  it("Promise.all with same hash calls adapter.synth exactly once", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");

    const [r1, r2] = await Promise.all([cache.get(baseReq()), cache.get(baseReq())]);

    expect(synthSpy).toHaveBeenCalledOnce();
    expect(r1.wavPath).toBe(r2.wavPath);
    expect(r1.durationSamples).toBe(r2.durationSamples);
    expect(r1.hash).toBe(r2.hash);
  });

  it("pendingMisses is empty after miss resolves — proves finally cleanup ran", async () => {
    await cache.get(baseReq()); // miss

    // If finally { delete } were removed, size would be 1 here.
    expect(pendingMissesMap(cache).size).toBe(0);

    // Regression: subsequent sequential call is still a filesystem hit.
    const synthSpy = vi.spyOn(adapter, "synth");
    await cache.get(baseReq());
    expect(synthSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Synth rejection cleanup (FIX 2a)
// ---------------------------------------------------------------------------

describe("CacheLayer — synth rejection cleanup", () => {
  it("rejection clears pendingMisses — later get() on same key succeeds", async () => {
    const synthSpy = vi.spyOn(adapter, "synth")
      .mockRejectedValueOnce(new Error("synth failed"));

    // First call: synth rejects → get() rejects.
    await expect(cache.get(baseReq())).rejects.toThrow("synth failed");

    // Map must be empty (finally ran despite the rejection).
    expect(pendingMissesMap(cache).size).toBe(0);

    // Second call: mockRejectedValueOnce consumed, real synth runs → succeeds.
    const result = await cache.get(baseReq());
    expect(result.durationSamples).toBeGreaterThan(0);
    expect(synthSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Exclusive-create write: stale .tmp unlinked before wx open
// ---------------------------------------------------------------------------

describe("CacheLayer — exclusive-create write (wx flag + stale tmp unlink)", () => {
  it("pre-existing stale .tmp is unlinked before wx write — final .wav is written", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");

    const hash = deriveKey(baseReq(), adapter);
    const tmpPath = join(tmpDir, `${hash}.wav.tmp`);
    const wavPath = join(tmpDir, `${hash}.wav`);
    await writeFile(tmpPath, Buffer.from("stale garbage content"));

    const result = await cache.get(baseReq());

    expect(synthSpy).toHaveBeenCalledOnce();
    expect(existsSync(wavPath)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false); // renamed → .wav
    expect(result.durationSamples).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. EEXIST fallback — cross-process race (FIX 1 + FIX 2c)
//
// Writer sequence: unlink .tmp → wx write .tmp → ffprobe → write sidecar → rename .tmp→.wav.
// A loser that hits EEXIST on the wx open must:
//   • Poll the normal hit-check (wav AND sidecar both present) a bounded number of times.
//   • Return the verified hit when both are present (Gap A closed: wav confirmed).
//   • Throw SoundstageError("E_CACHE_CONTENTION") if budget exhausted (Gap B closed: no raw EEXIST).
//   • Never unlink or re-synthesize in this path (would clobber the winner's .tmp).
// ---------------------------------------------------------------------------

describe("CacheLayer — EEXIST fallback (cross-process winner)", () => {
  const ENOENT = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const EEXIST_ERR = Object.assign(new Error("EEXIST: file already exists, open"), { code: "EEXIST" });

  /** Make a CacheLayer with fast poll params so tests run without real delays. */
  function makeEexistCache(maxAttempts = 3) {
    return new CacheLayer(adapter, tmpDir, { eexistPollDelayMs: 0, eexistMaxAttempts: maxAttempts });
  }

  it("first poll finds completed entry — returns hit immediately", async () => {
    const hash = deriveKey(baseReq(), adapter);
    const wavPath = join(tmpDir, `${hash}.wav`);
    const jsonPath = join(tmpDir, `${hash}.json`);
    const eexistCache = makeEexistCache();

    // Pre-populate sidecar before queuing the EEXIST mock.
    await writeFile(jsonPath, JSON.stringify(WINNER_SIDECAR, null, 2), "utf8");

    // Queue: wx write → EEXIST.
    (writeFile as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { throw EEXIST_ERR; });
    // access: call 1 (hit check) → miss; call 2 (poll 0) → wav present.
    (access as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(ENOENT)
      .mockResolvedValueOnce(undefined);

    const synthSpy = vi.spyOn(adapter, "synth");
    const result = await eexistCache.get(baseReq());

    expect(synthSpy).toHaveBeenCalledOnce(); // miss path, not hit path
    expect(result.hit).toBe(true);
    expect(result.durationSamples).toBe(12000);
    expect(result.sampleRate).toBe(24000);
    expect(result.wavPath).toBe(wavPath);
  });

  it("winner mid-write: sidecar absent on first poll, present on second — returns hit", async () => {
    const hash = deriveKey(baseReq(), adapter);
    const wavPath = join(tmpDir, `${hash}.wav`);
    const eexistCache = makeEexistCache();

    // Queue: wx write → EEXIST.
    (writeFile as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { throw EEXIST_ERR; });
    // access: hit check miss, poll 0 wav found, poll 1 wav found.
    (access as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(ENOENT)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    // readFile: poll 0 sidecar absent, poll 1 sidecar present.
    (readFile as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(ENOENT)
      .mockResolvedValueOnce(JSON.stringify(WINNER_SIDECAR));

    const synthSpy = vi.spyOn(adapter, "synth");
    const result = await eexistCache.get(baseReq());

    expect(synthSpy).toHaveBeenCalledOnce();
    expect(result.hit).toBe(true);
    expect(result.durationSamples).toBe(12000);
    expect(result.wavPath).toBe(wavPath);
  });

  it("winner never completes — all polls fail → SoundstageError(E_CACHE_CONTENTION)", async () => {
    // maxAttempts: 2 → 1 hit-check access + 2 poll accesses = 3 calls, all failing.
    const eexistCache = makeEexistCache(2);

    // Queue: wx write → EEXIST.
    (writeFile as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { throw EEXIST_ERR; });
    // All 3 access(wavPath) calls → ENOENT.
    (access as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(ENOENT)
      .mockRejectedValueOnce(ENOENT)
      .mockRejectedValueOnce(ENOENT);

    let caughtErr: unknown;
    try {
      await eexistCache.get(baseReq());
    } catch (e) {
      caughtErr = e;
    }

    // Must be a structured SoundstageError, NOT a raw EEXIST OS error.
    expect(caughtErr).toBeInstanceOf(SoundstageError);
    expect((caughtErr as SoundstageError).code).toBe("E_CACHE_CONTENTION");
    expect((caughtErr as SoundstageError).message).toMatch(/retry/i);
  });
});
