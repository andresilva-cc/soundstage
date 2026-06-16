// Integration tests for CacheLayer — correctness-critical, adversarial.
// Uses the synthetic adapter as collaborator (hermetic, no network).
// Real tmp dir, real ffprobe calls for sidecar validation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import type { SynthRequest } from "../../src/adapters/types.js";

function baseReq(overrides: Partial<SynthRequest> = {}): SynthRequest {
  return {
    text: "hello world",
    voice: "host",
    sampleRate: 24000,
    ...overrides,
  };
}

let tmpDir: string;
let adapter: SyntheticAdapter;
let cache: CacheLayer;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-cache-test-"));
  adapter = new SyntheticAdapter();
  cache = new CacheLayer(adapter, tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("CacheLayer — cache miss", () => {
  it("calls adapter on miss and returns durationSamples > 0", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");
    const result = await cache.get(baseReq());

    expect(synthSpy).toHaveBeenCalledOnce();
    expect(result.durationSamples).toBeGreaterThan(0);
    expect(result.sampleRate).toBeGreaterThan(0);
    expect(result.wavPath).toMatch(/\.wav$/);
  });

  it("writes {hash}.wav and {hash}.json on miss", async () => {
    const result = await cache.get(baseReq());

    const wavPath = result.wavPath;
    const jsonPath = wavPath.replace(/\.wav$/, ".json");

    expect(existsSync(wavPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
  });

  it("sidecar durationSamples round-trips: get() returns same value as sidecar JSON", async () => {
    const result = await cache.get(baseReq());

    // The returned durationSamples should match what ffprobe actually measured
    // and recorded in the sidecar — the cache returns the sidecar value.
    expect(result.durationSamples).toBeGreaterThan(0);

    // Verify the sidecar can be parsed and matches the returned value
    const { readFile } = await import("node:fs/promises");
    const jsonPath = result.wavPath.replace(/\.wav$/, ".json");
    const sidecar = JSON.parse(await readFile(jsonPath, "utf8")) as {
      durationSamples: number;
      sampleRate: number;
      sampleFmt: string;
      channels: number;
      ffprobeVersion: string;
      adapterId: string;
      model: string;
      createdAt: string;
    };

    expect(sidecar.durationSamples).toBe(result.durationSamples);
    expect(sidecar.sampleRate).toBe(result.sampleRate);
    expect(sidecar.sampleFmt).toBe("f32le");
    expect(sidecar.channels).toBe(1);
    // Must match a real version string (e.g. "ffprobe version 7.1") — "unknown" is a failure
    expect(sidecar.ffprobeVersion).toMatch(/ffprobe\s+version\s+\d+/i);
    expect(sidecar.adapterId).toBe("synthetic");
    expect(sidecar.model).toBe("synthetic-v1");
    // createdAt must be a valid ISO 8601 date string
    expect(isNaN(Date.parse(sidecar.createdAt))).toBe(false);
  });
});

describe("CacheLayer — no-alias (different inputs → different entries)", () => {
  it("same voice/settings but different text → different wavPath", async () => {
    const r1 = await cache.get(baseReq({ text: "hello world" }));
    const r2 = await cache.get(baseReq({ text: "goodbye world" }));
    expect(r1.wavPath).not.toBe(r2.wavPath);
  });
});

describe("CacheLayer — cache hit", () => {
  it("second call with same request does not call adapter", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");

    await cache.get(baseReq());
    expect(synthSpy).toHaveBeenCalledOnce();

    synthSpy.mockClear();
    await cache.get(baseReq());
    expect(synthSpy).not.toHaveBeenCalled();
  });

  it("hit returns same durationSamples as miss", async () => {
    const first = await cache.get(baseReq());
    const second = await cache.get(baseReq());

    expect(second.durationSamples).toBe(first.durationSamples);
    expect(second.sampleRate).toBe(first.sampleRate);
    expect(second.wavPath).toBe(first.wavPath);
  });

  it("hit with same text but different voice is a separate entry", async () => {
    const r1 = await cache.get(baseReq({ voice: "host-a" }));
    const r2 = await cache.get(baseReq({ voice: "host-b" }));
    expect(r1.wavPath).not.toBe(r2.wavPath);
  });
});

describe("CacheLayer — atomicity", () => {
  it("pre-existing .wav.tmp does NOT cause a hit — adapter is still called", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");

    // Derive what the hash key would be to create the .tmp file manually
    const { deriveKey } = await import("../../src/adapters/cache/key.js");
    const hash = deriveKey(baseReq(), adapter);
    const tmpPath = join(tmpDir, `${hash}.wav.tmp`);

    // Pre-create the .tmp file with garbage content (simulates leftover from crashed write)
    await writeFile(tmpPath, Buffer.from("garbage"));

    // Should treat as miss: adapter called, .tmp overwritten
    const result = await cache.get(baseReq());
    expect(synthSpy).toHaveBeenCalledOnce();
    expect(result.durationSamples).toBeGreaterThan(0);

    // After the call, the .wav should exist and the .tmp should NOT remain as garbage
    // (it may no longer exist, or it may be the final wav — either way the final .wav exists)
    expect(existsSync(result.wavPath)).toBe(true);
  });

  it("final .wav is written atomically (rename, not direct write)", async () => {
    // After a cache miss completes, .wav.tmp should not exist
    const { deriveKey } = await import("../../src/adapters/cache/key.js");
    const hash = deriveKey(baseReq(), adapter);
    const tmpPath = join(tmpDir, `${hash}.wav.tmp`);

    await cache.get(baseReq());

    // .tmp should be gone after atomic rename
    expect(existsSync(tmpPath)).toBe(false);
  });
});

describe("CacheLayer — sidecar NaN / non-integer guard", () => {
  it("sidecar with durationSamples: NaN is treated as a miss (re-synths)", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");

    // Prime the cache
    await cache.get(baseReq());
    expect(synthSpy).toHaveBeenCalledOnce();

    // Overwrite sidecar with NaN durationSamples
    const { deriveKey } = await import("../../src/adapters/cache/key.js");
    const hash = deriveKey(baseReq(), adapter);
    const jsonPath = join(tmpDir, `${hash}.json`);
    await writeFile(jsonPath, JSON.stringify({ durationSamples: NaN, sampleRate: 24000 }), "utf8");

    synthSpy.mockClear();
    const result = await cache.get(baseReq());
    expect(synthSpy).toHaveBeenCalledOnce();
    expect(Number.isInteger(result.durationSamples)).toBe(true);
    expect(result.durationSamples).toBeGreaterThan(0);
  });

  it("sidecar with durationSamples: 1.5 (non-integer) is treated as a miss", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");

    await cache.get(baseReq());
    expect(synthSpy).toHaveBeenCalledOnce();

    const { deriveKey } = await import("../../src/adapters/cache/key.js");
    const hash = deriveKey(baseReq(), adapter);
    const jsonPath = join(tmpDir, `${hash}.json`);
    await writeFile(jsonPath, JSON.stringify({ durationSamples: 1.5, sampleRate: 24000 }), "utf8");

    synthSpy.mockClear();
    const result = await cache.get(baseReq());
    expect(synthSpy).toHaveBeenCalledOnce();
    expect(result.durationSamples).toBeGreaterThan(0);
  });
});

describe("CacheLayer — corrupt/missing sidecar", () => {
  it("missing sidecar after wav exists: treats as miss (re-synths)", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");

    // Prime the cache
    await cache.get(baseReq());
    expect(synthSpy).toHaveBeenCalledOnce();

    // Remove the sidecar to simulate corruption
    const { deriveKey } = await import("../../src/adapters/cache/key.js");
    const hash = deriveKey(baseReq(), adapter);
    const jsonPath = join(tmpDir, `${hash}.json`);
    await rm(jsonPath);

    synthSpy.mockClear();
    // Should re-synth (treat as miss), not crash
    const result = await cache.get(baseReq());
    expect(synthSpy).toHaveBeenCalledOnce();
    expect(result.durationSamples).toBeGreaterThan(0);
  });

  it("corrupt sidecar (invalid JSON): treats as miss, does not crash", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");

    await cache.get(baseReq());

    const { deriveKey } = await import("../../src/adapters/cache/key.js");
    const hash = deriveKey(baseReq(), adapter);
    const jsonPath = join(tmpDir, `${hash}.json`);
    await writeFile(jsonPath, "not-valid-json{{{");

    synthSpy.mockClear();
    const result = await cache.get(baseReq());
    expect(synthSpy).toHaveBeenCalledOnce();
    expect(result.durationSamples).toBeGreaterThan(0);
  });
});

describe("CacheLayer — --no-cache flag", () => {
  it("bypass-read: adapter called even on a warm entry", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");

    // Prime the cache
    await cache.get(baseReq());
    expect(synthSpy).toHaveBeenCalledOnce();

    synthSpy.mockClear();

    // With noCache: true, adapter is called again
    const noCacheLayer = new CacheLayer(adapter, tmpDir, { noCache: true });
    await noCacheLayer.get(baseReq());
    expect(synthSpy).toHaveBeenCalledOnce();
  });

  it("still writes {hash}.wav on no-cache miss path", async () => {
    const noCacheLayer = new CacheLayer(adapter, tmpDir, { noCache: true });
    const result = await noCacheLayer.get(baseReq());

    expect(existsSync(result.wavPath)).toBe(true);
    const jsonPath = result.wavPath.replace(/\.wav$/, ".json");
    expect(existsSync(jsonPath)).toBe(true);
  });

  it("no-cache always re-synths even on second call", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");
    const noCacheLayer = new CacheLayer(adapter, tmpDir, { noCache: true });

    await noCacheLayer.get(baseReq());
    await noCacheLayer.get(baseReq());

    expect(synthSpy).toHaveBeenCalledTimes(2);
  });
});

describe("CacheLayer — PCM size sanity cap", () => {
  it("throws RangeError when adapter returns PCM exceeding 30 minutes", async () => {
    const sampleRate = 24000;
    const oversizedPcm = new Float32Array(30 * 60 * sampleRate + 1); // 30 min + 1 sample
    vi.spyOn(adapter, "synth").mockResolvedValue({
      pcm: oversizedPcm,
      sampleRate,
      durationSamples: oversizedPcm.length,
    });
    await expect(cache.get(baseReq())).rejects.toThrow(RangeError);
  });
});

describe("CacheLayer — sidecar ffprobe measurement accuracy", () => {
  it("sidecar durationSamples is within 10% of pcm.length at sampleRate", async () => {
    // The synthetic adapter's durationSamples is known; the WAV is f32le so
    // ffprobe's measurement should match within a small tolerance (WAV headers exact).
    const synthSpy = vi.spyOn(adapter, "synth");
    const result = await cache.get(baseReq());

    // Get what the adapter produced
    const call = synthSpy.mock.results[0];
    if (!call || call.type !== "return") throw new Error("No synth result");
    const synthResult = await call.value as { durationSamples: number; sampleRate: number };

    // The sidecar duration should match the PCM duration closely.
    // f32le WAV: exact sample count, so should be within a small delta.
    const tolerance = Math.ceil(synthResult.durationSamples * 0.01); // 1% tolerance
    expect(Math.abs(result.durationSamples - synthResult.durationSamples)).toBeLessThanOrEqual(tolerance);
  });
});

describe("CacheLayer — APFS case safety", () => {
  it("voice Host and host map to the same cache entry (same .wav path)", async () => {
    const r1 = await cache.get(baseReq({ voice: "Host" }));
    const r2 = await cache.get(baseReq({ voice: "host" }));
    expect(r1.wavPath).toBe(r2.wavPath);
  });

  it("hash filename is all lowercase hex (never triggers APFS case collision)", async () => {
    const result = await cache.get(baseReq());
    const filename = result.wavPath.split("/").pop()!;
    expect(filename).toMatch(/^[0-9a-f]{64}\.wav$/);
  });

  it("voice Host and host produce the same key AND adapter receives lowercased voice", async () => {
    const synthSpy = vi.spyOn(adapter, "synth");

    await cache.get(baseReq({ voice: "Host" }));
    await cache.get(baseReq({ voice: "host" }));

    // Only one synth call — same key so second is a cache hit
    expect(synthSpy).toHaveBeenCalledOnce();

    // The adapter must have received the lowercased voice
    const callArg = synthSpy.mock.calls[0]?.[0];
    expect(callArg?.voice).toBe("host");
  });
});
