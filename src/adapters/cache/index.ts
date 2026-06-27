// §4.5 — CacheLayer: content-hash cache wrapping a TtsAdapter.
//
// Miss path: synth → write f32le WAV to {hash}.wav.<random>.tmp → ffprobe duration
//            → write {hash}.json sidecar (NOT atomic — covered by readSidecar's
//              null-on-error→treat-as-miss guard; do NOT remove that guard)
//            → rename tmp → {hash}.wav  ← this rename IS the atomic commit.
// Hit path:  wav present + sidecar valid → return cached path + sidecar duration.
// Missing/corrupt sidecar → treat as miss (re-synth), never a crash.
//
// Cross-process safety: each write uses a process-unique tmp name (randomBytes),
// so concurrent processes never clobber each other's mid-ffprobe tmp file.
// The final rename(tmp→wav) is POSIX-atomic; if another process renamed first
// our rename atomically overwrites with identical (deterministic) content.
// Note: two concurrent PROCESSES may each synthesize the same voice unit.
// pendingMisses only dedups within one process — the cross-process double-synth
// is a deliberate, acceptable trade-off for a local CLI tool.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { access, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { deriveKey } from "./key.js";
import { normalizeText } from "./canonical.js";
import { runFfprobe } from "../../probe/ffprobe.js";
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
    const jsonPath = join(this.cacheDir, `${hash}.json`);

    // Check for a valid hit: wav and sidecar both present, not bypassing reads.
    const wavExists = !this.noCache && await access(wavPath).then(() => true, () => false);
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

      // Each miss gets a process-unique tmp name so concurrent processes never
      // race on the same file. The random suffix makes collision impossible, so
      // wx never false-fails — but it formally closes the CWE-377 symlink-follow
      // hazard (default O_WRONLY|O_CREAT would follow a symlink; O_EXCL rejects
      // any pre-existing path, including adversarially placed symlinks).
      const uniqueTmpPath = join(
        this.cacheDir,
        `${hash}.wav.${randomBytes(8).toString("hex")}.tmp`
      );

      try {
        await writeFile(uniqueTmpPath, wavBuffer, { flag: "wx" });

        // ffprobe measures the real duration from the tmp file.
        const { durationSamples, sampleRate, ffprobeVersion } = await probeDuration(uniqueTmpPath);

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

        // Atomic rename: unique tmp → final wav. POSIX rename(2) atomically
        // replaces the destination, so if another process won the race our rename
        // overwrites with identical (deterministic) content — no error thrown.
        await rename(uniqueTmpPath, wavPath);

        return { wavPath, durationSamples, sampleRate, hash, hit: false };
      } catch (e) {
        // Clean up this write's unique tmp on any error — no leaked .tmp files.
        await unlink(uniqueTmpPath).catch(() => { /* already gone or never created */ });
        throw e;
      }
    })();

    this.pendingMisses.set(hash, missPromise);
    try {
      return await missPromise;
    } finally {
      this.pendingMisses.delete(hash);
    }
  }
}
