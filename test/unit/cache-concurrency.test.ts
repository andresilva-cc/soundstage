// Unit tests for CacheLayer concurrency hardening (Issues #22, #64).
//
// FIX 1 (T11, in-process): pendingMisses promise-map deduplicates concurrent
//   same-hash calls within one process — synth runs exactly once.
//
// FIX 2 (T4/Issue #64, cross-process): each miss uses a process-unique tmp name
//   ({hash}.wav.<randomBytes>.tmp) so concurrent processes never race on the same
//   file. Both writes succeed; the POSIX-atomic rename handles final contention.
//
// The cross-process regression test uses a controlled delay to force the
// problematic interleaving: cache1's ffprobe (delayed 200 ms via mock) overlaps
// with cache2's write (synth delayed 20 ms). Under the OLD shared-tmp +
// unlink-stale scheme cache2 would delete cache1's file mid-ffprobe and the
// test would fail. Under the new unique-tmp scheme neither write interferes.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type * as NodeFfprobe from "../../src/probe/ffprobe.js";

// vi.mock is hoisted — wraps runFfprobe so individual tests can queue delays.
vi.mock("../../src/probe/ffprobe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFfprobe>();
  return {
    ...actual,
    runFfprobe: vi.fn(actual.runFfprobe),
  };
});

import { runFfprobe } from "../../src/probe/ffprobe.js";

import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import type { SynthRequest, SynthResult } from "../../src/adapters/types.js";

function baseReq(overrides: Partial<SynthRequest> = {}): SynthRequest {
  return { text: "concurrent test", voice: "host", sampleRate: 24000, ...overrides };
}

/** Cast to access the private pendingMisses map for assertions. */
function pendingMissesMap(c: CacheLayer): Map<string, unknown> {
  return (c as unknown as { pendingMisses: Map<string, unknown> }).pendingMisses;
}

/** SyntheticAdapter that adds a fixed delay before synth completes. */
class SlowSynthAdapter extends SyntheticAdapter {
  constructor(private readonly delayMs: number) { super(); }
  override async synth(req: SynthRequest): Promise<SynthResult> {
    await new Promise<void>((r) => setTimeout(r, this.delayMs));
    return super.synth(req);
  }
}

let tmpDir: string;
let adapter: SyntheticAdapter;
let cache: CacheLayer;

beforeEach(async () => {
  vi.clearAllMocks(); // resets call counts; default implementations are preserved
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
// 2. Synth rejection cleanup
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
// 3. Cross-process unique tmp: concurrent writers never clobber each other
//
// Two separate CacheLayer instances simulate two OS processes sharing the same
// cache directory. Each has its own pendingMisses map (no cross-instance dedup),
// so both call synth and both write to the cache dir concurrently.
//
// Deterministic interleaving (FIX 2):
//   • cache1 uses SyntheticAdapter (instant synth) → writes tmp, then enters
//     a 200 ms delayed ffprobe (via mockImplementationOnce).
//   • cache2 uses SlowSynthAdapter(20 ms) → its synth starts after 20 ms, so
//     its write step overlaps with cache1's running (delayed) ffprobe.
//   • Under old shared-tmp + unlink-stale: cache2 unlinks cache1's tmp
//     mid-ffprobe → cache1's ffprobe throws → test fails.
//   • Under new unique-tmp: each writer probes its own file → both succeed.
//
// FIX 3: after the concurrent run, a third instance reads the sidecar via a
// warm hit to catch partial/corrupt sidecar writes from concurrent overwrite.
// ---------------------------------------------------------------------------

describe("CacheLayer — cross-process unique tmp: concurrent writers", () => {
  it("two CacheLayer instances on the same cacheDir both succeed — no clobber, no leaked .tmp, sidecar survives", async () => {
    // Get the real runFfprobe to call from inside the delay wrapper.
    const { runFfprobe: realRunFfprobe } =
      await vi.importActual<typeof NodeFfprobe>("../../src/probe/ffprobe.js");

    // Delay the FIRST runFfprobe invocation (cache1's tmp probe) by 200 ms.
    // This guarantees cache2's synth (20 ms delay) completes and writes its tmp
    // WHILE cache1 is blocked inside ffprobe — forcing the problematic overlap.
    (runFfprobe as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (...args: Parameters<typeof runFfprobe>) => {
        await new Promise<void>((r) => setTimeout(r, 200));
        return realRunFfprobe(...args);
      }
    );

    const adapter1 = new SyntheticAdapter();          // instant synth → writes tmp first
    const adapter2 = new SlowSynthAdapter(20);        // 20 ms delay → writes during cache1's ffprobe
    const synth1 = vi.spyOn(adapter1, "synth");
    const synth2 = vi.spyOn(adapter2, "synth");
    const cache1 = new CacheLayer(adapter1, tmpDir);
    const cache2 = new CacheLayer(adapter2, tmpDir);

    // Both miss (cold cache) and write concurrently.
    const [r1, r2] = await Promise.all([
      cache1.get(baseReq()),
      cache2.get(baseReq()),
    ]);

    // Both adapters synthesized independently (no cross-instance dedup).
    expect(synth1).toHaveBeenCalledOnce();
    expect(synth2).toHaveBeenCalledOnce();

    // Both return a valid result pointing to the same final wav.
    expect(r1.durationSamples).toBeGreaterThan(0);
    expect(r2.durationSamples).toBeGreaterThan(0);
    expect(r1.wavPath).toBe(r2.wavPath);

    // Final wav committed on disk.
    expect(existsSync(r1.wavPath)).toBe(true);

    // No .tmp files leaked — each writer's unique tmp was renamed or error-cleaned.
    const leaked = readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"));
    expect(leaked).toHaveLength(0);

    // FIX 3: sidecar round-trip — a warm hit on a third instance reads the
    // persisted sidecar. A corrupted or half-written {hash}.json would cause
    // re-synth (hit=false) or wrong durationSamples — both caught here.
    const adapter3 = new SyntheticAdapter();
    const synth3 = vi.spyOn(adapter3, "synth");
    const cache3 = new CacheLayer(adapter3, tmpDir);
    const warmHit = await cache3.get(baseReq());

    expect(synth3).not.toHaveBeenCalled();       // warm hit — sidecar intact
    expect(warmHit.hit).toBe(true);
    expect(warmHit.durationSamples).toBe(r1.durationSamples); // sidecar value matches ffprobe result
    expect(warmHit.durationSamples).toBeGreaterThan(0);
  }, 10_000); // generous timeout: 200 ms mock delay + real ffprobe × 2 + synth

  it("warm cache: second instance returns hit immediately — no double synth", async () => {
    // First writer populates the cache.
    const adapter1 = new SyntheticAdapter();
    const cache1 = new CacheLayer(adapter1, tmpDir);
    await cache1.get(baseReq());

    // Second instance hits the already-written cache — no synth needed.
    const adapter2 = new SyntheticAdapter();
    const synth2 = vi.spyOn(adapter2, "synth");
    const cache2 = new CacheLayer(adapter2, tmpDir);
    const result = await cache2.get(baseReq());

    expect(synth2).not.toHaveBeenCalled();
    expect(result.hit).toBe(true);
    expect(result.durationSamples).toBeGreaterThan(0);
  });
});
