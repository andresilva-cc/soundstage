// §4.5 — CacheLayer: content-hash cache wrapping a TtsAdapter.
// On miss: synth → write f32le WAV to {hash}.wav.tmp → ffprobe duration →
//          write {hash}.json sidecar → rename .tmp → .wav (atomic).
// On hit: sidecar present + wav present → return cached path + sidecar duration.
// Pre-existing .wav.tmp is treated as a miss (overwritten).
// Missing/corrupt sidecar is treated as a miss (re-synth), never a crash.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { deriveKey } from "./key.js";
import { normalizeText } from "./canonical.js";
import { runFfprobe } from "../../probe/ffprobe.js";
import { SoundstageError } from "../../ir/errors.js";
import type { TtsAdapter, SynthRequest } from "../types.js";

const execFileAsync = promisify(execFile);

/** Lazy singleton — ffprobe -version runs once per process. */
let ffprobeVersionPromise: Promise<string> | undefined;

function getFfprobeVersion(): Promise<string> {
  if (!ffprobeVersionPromise) {
    ffprobeVersionPromise = execFileAsync("ffprobe", ["-version"], { encoding: "utf8" }).then(
      ({ stdout }) => stdout.split("\n")[0]?.trim() ?? "unknown"
    );
  }
  return ffprobeVersionPromise;
}

export interface CacheResult {
  wavPath: string;
  durationSamples: number;
  sampleRate: number;
  /** Content hash (hex SHA-256) — same value as the WAV filename stem. */
  hash: string;
  /** True when the result was served from cache (hit); false when synthesized (miss). */
  hit: boolean;
}

export interface CacheOptions {
  /** When true: bypass reading (always re-synth) but still write entries. */
  noCache?: boolean;
  /** Milliseconds to wait between cross-process hit polls on EEXIST. Default: 100. */
  eexistPollDelayMs?: number;
  /** Maximum poll attempts before throwing E_CACHE_CONTENTION on EEXIST. Default: 10. */
  eexistMaxAttempts?: number;
}

interface DurationSidecar {
  durationSamples: number;
  sampleRate: number;
  sampleFmt: string;
  channels: number;
  ffprobeVersion: string;
  adapterId: string;
  model: string;
  createdAt: string;
}

/** Maximum PCM length accepted by buildF32leWav (30 minutes at the given sample rate). */
const MAX_PCM_SAMPLES_PER_HZ = 30 * 60; // 1800 seconds

/**
 * Write a Float32Array as a mono f32le WAV file.
 * WAV format: RIFF header + data chunk.
 * Throws if pcm.length exceeds 30 minutes at sampleRate (OOM/disk-fill guard).
 */
function buildF32leWav(pcm: Float32Array, sampleRate: number): Buffer {
  const maxSamples = MAX_PCM_SAMPLES_PER_HZ * sampleRate;
  if (pcm.length > maxSamples) {
    throw new RangeError(
      `buildF32leWav: PCM too large (${pcm.length} samples > ${maxSamples} max at ${sampleRate} Hz)`
    );
  }
  const channels = 1;
  const bitsPerSample = 32;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length * 4; // 4 bytes per f32le sample
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  // RIFF chunk
  buf.write("RIFF", offset); offset += 4;
  buf.writeUInt32LE(totalSize - 8, offset); offset += 4;
  buf.write("WAVE", offset); offset += 4;

  // fmt sub-chunk: IEEE float = 3
  buf.write("fmt ", offset); offset += 4;
  buf.writeUInt32LE(16, offset); offset += 4;         // sub-chunk size
  buf.writeUInt16LE(3, offset); offset += 2;          // PCM float format (IEEE 754)
  buf.writeUInt16LE(channels, offset); offset += 2;
  buf.writeUInt32LE(sampleRate, offset); offset += 4;
  buf.writeUInt32LE(byteRate, offset); offset += 4;
  buf.writeUInt16LE(blockAlign, offset); offset += 2;
  buf.writeUInt16LE(bitsPerSample, offset); offset += 2;

  // data sub-chunk
  buf.write("data", offset); offset += 4;
  buf.writeUInt32LE(dataSize, offset); offset += 4;

  // Write f32le samples
  for (let i = 0; i < pcm.length; i++) {
    buf.writeFloatLE(pcm[i]!, offset);
    offset += 4;
  }

  return buf;
}

/**
 * Run ffprobe on a WAV file and return the stream's sample count + sample rate.
 * Uses the shared runFfprobe helper (prefers nb_samples for WAV, falls back to duration×rate).
 */
async function probeDuration(
  wavPath: string
): Promise<{ durationSamples: number; sampleRate: number; ffprobeVersion: string }> {
  const ffprobeVersion = await getFfprobeVersion();

  const { nbSamples, sampleRate, durationSec } = await runFfprobe(
    wavPath,
    "stream=nb_samples,sample_rate,duration_ts,duration",
  );

  // Prefer nb_samples (exact integer count, present in WAV)
  if (nbSamples !== undefined) {
    return { durationSamples: nbSamples, sampleRate, ffprobeVersion };
  }

  // Fallback: duration (seconds) × sample_rate
  if (durationSec !== undefined && sampleRate > 0) {
    return {
      durationSamples: Math.round(durationSec * sampleRate),
      sampleRate,
      ffprobeVersion,
    };
  }

  throw new Error(`ffprobe: could not determine duration for ${wavPath}`);
}

/**
 * Try to read and parse a sidecar JSON file.
 * Returns null if the file does not exist or is corrupt/unparseable.
 */
async function readSidecar(jsonPath: string): Promise<DurationSidecar | null> {
  try {
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as DurationSidecar;
    // Guard: durationSamples must be a positive integer (NaN, float, <=0 → miss)
    if (!Number.isInteger(parsed.durationSamples) || parsed.durationSamples <= 0) {
      return null;
    }
    // Guard: sampleRate must be a positive integer
    if (!Number.isInteger(parsed.sampleRate) || parsed.sampleRate <= 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * CacheLayer wraps a TtsAdapter with a content-hash on-disk cache.
 * Cache dir: the cacheDir argument (e.g. `.soundstage/cache/` relative to project root).
 */
export class CacheLayer {
  private readonly adapter: TtsAdapter;
  private readonly cacheDir: string;
  private readonly noCache: boolean;
  private readonly eexistPollDelayMs: number;
  private readonly eexistMaxAttempts: number;

  /** The underlying adapter's stable provider id (e.g. "kokoro", "synthetic"). */
  readonly adapterId: string;

  /**
   * Per-hash in-process promise map.
   * When two concurrent calls miss on the same hash, the second awaiter reuses
   * the first's Promise so synthesis runs exactly once.
   */
  private readonly pendingMisses = new Map<string, Promise<CacheResult>>();

  constructor(adapter: TtsAdapter, cacheDir: string, options: CacheOptions = {}) {
    this.adapter = adapter;
    this.cacheDir = cacheDir;
    this.noCache = options.noCache ?? false;
    this.eexistPollDelayMs = options.eexistPollDelayMs ?? 100;
    this.eexistMaxAttempts = options.eexistMaxAttempts ?? 10;
    this.adapterId = adapter.id;
  }

  /**
   * Get cached audio for the request, synthesizing if necessary.
   * Returns the WAV path, sidecar duration, and hash (never a re-probe on hit).
   */
  async get(req: SynthRequest): Promise<CacheResult> {
    // Build a single normalized request — same object used for BOTH key derivation
    // and adapter synthesis so the cache key and the audio always match.
    const normalizedReq: SynthRequest = {
      ...req,
      text: normalizeText(req.text),
      voice: req.voice.toLowerCase(),
    };

    const hash = deriveKey(normalizedReq, this.adapter);
    const wavPath = join(this.cacheDir, `${hash}.wav`);
    const tmpPath = join(this.cacheDir, `${hash}.wav.tmp`);
    const jsonPath = join(this.cacheDir, `${hash}.json`);

    // Check for a valid hit: both wav and sidecar present, and not bypassing reads.
    // A pre-existing .wav.tmp is explicitly NOT a hit (§4.5: treat as miss).
    const wavExists = !this.noCache && await access(wavPath).then(() => true, () => false);
    const tmpExists = wavExists && await access(tmpPath).then(() => true, () => false);
    if (wavExists && !tmpExists) {
      const sidecar = await readSidecar(jsonPath);
      if (sidecar !== null) {
        return {
          wavPath,
          durationSamples: sidecar.durationSamples,
          sampleRate: sidecar.sampleRate,
          hash,
          hit: true,
        };
      }
      // Sidecar missing or corrupt: fall through to miss path
    }

    // Miss path — deduplicate concurrent in-process misses on the same hash.
    const inflight = this.pendingMisses.get(hash);
    if (inflight !== undefined) return inflight;

    // Build the synthesis+write promise and register it BEFORE the first await so
    // any concurrent caller that reaches this point sees it in the map.
    const missPromise = (async (): Promise<CacheResult> => {
      const result = await this.adapter.synth(normalizedReq);

      // Build f32le WAV buffer.
      const wavBuffer = buildF32leWav(result.pcm, result.sampleRate);

      // Exclusive-create write (CWE-377 fix):
      //   1. Unlink any stale .tmp (crashed prior write) — ignore ENOENT.
      //   2. Open with flag 'wx' (fail if exists) — prevents symlink-follow attack.
      //   3. On EEXIST: a concurrent process won the race; fall back to its sidecar.
      await unlink(tmpPath).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });

      try {
        await writeFile(tmpPath, wavBuffer, { flag: "wx" });
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "EEXIST") {
          // Concurrent process won the wx-open race.
          // Poll the normal hit-check (wav AND sidecar) instead of reading once:
          //  • Gap A closed: we verify the wav exists before returning its path.
          //  • Gap B closed: if the winner hasn't finished yet we retry rather than
          //    rethrowing a raw EEXIST or returning an unverified path.
          return await this.awaitConcurrentEntry(wavPath, jsonPath, hash);
        }
        throw e;
      }

      // ffprobe measures the real duration from the file.
      const { durationSamples, sampleRate, ffprobeVersion } = await probeDuration(tmpPath);

      // Write sidecar JSON.
      const sidecar: DurationSidecar = {
        durationSamples,
        sampleRate,
        sampleFmt: "f32le",
        channels: 1,
        ffprobeVersion,
        adapterId: this.adapter.id,
        model: this.adapter.model,
        createdAt: new Date().toISOString(),
      };
      await writeFile(jsonPath, JSON.stringify(sidecar, null, 2), "utf8");

      // Atomic rename: .tmp → .wav
      await rename(tmpPath, wavPath);

      return { wavPath, durationSamples, sampleRate, hash, hit: false };
    })();

    this.pendingMisses.set(hash, missPromise);
    try {
      return await missPromise;
    } finally {
      this.pendingMisses.delete(hash);
    }
  }

  /**
   * Poll the normal hit-check (wav present AND sidecar valid) after losing the
   * wx-open race to a concurrent process. Returns on the first completed hit.
   * Throws E_CACHE_CONTENTION if eexistMaxAttempts are exhausted without a hit.
   *
   * Delay is applied before each attempt except the first so callers get an
   * immediate first look at no cost.
   */
  private async awaitConcurrentEntry(
    wavPath: string,
    jsonPath: string,
    hash: string
  ): Promise<CacheResult> {
    for (let attempt = 0; attempt < this.eexistMaxAttempts; attempt++) {
      if (attempt > 0 && this.eexistPollDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.eexistPollDelayMs));
      }
      const wavExists = await access(wavPath).then(() => true, () => false);
      if (wavExists) {
        const sidecar = await readSidecar(jsonPath);
        if (sidecar !== null) {
          return {
            wavPath,
            durationSamples: sidecar.durationSamples,
            sampleRate: sidecar.sampleRate,
            hash,
            hit: true,
          };
        }
      }
    }
    throw new SoundstageError(
      "E_CACHE_CONTENTION",
      `concurrent process holds cache entry ${hash.slice(0, 8)}… — retry the render`,
      "cache"
    );
  }
}
