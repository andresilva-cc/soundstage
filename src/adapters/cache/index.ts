// §4.5 — CacheLayer: content-hash cache wrapping a TtsAdapter.
// On miss: synth → write f32le WAV to {hash}.wav.tmp → ffprobe duration →
//          write {hash}.json sidecar → rename .tmp → .wav (atomic).
// On hit: sidecar present + wav present → return cached path + sidecar duration.
// Pre-existing .wav.tmp is treated as a miss (overwritten).
// Missing/corrupt sidecar is treated as a miss (re-synth), never a crash.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { deriveKey } from "./key.js";
import { normalizeText } from "./canonical.js";
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

interface FfprobeStream {
  nb_samples?: number;
  sample_rate?: string;
  duration_ts?: number;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
}

/**
 * Run ffprobe on a WAV file and return the stream's sample count + sample rate.
 */
async function probeDuration(
  wavPath: string
): Promise<{ durationSamples: number; sampleRate: number; ffprobeVersion: string }> {
  const ffprobeVersion = await getFfprobeVersion();

  // Probe the file for stream info including nb_samples
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=nb_samples,sample_rate,duration_ts",
      "-of", "json",
      wavPath,
    ],
    { encoding: "utf8" }
  );

  const probe = JSON.parse(stdout) as FfprobeOutput;
  const stream = probe.streams[0];

  if (!stream) {
    throw new Error(`ffprobe: no audio stream found in ${wavPath}`);
  }

  const sampleRate = parseInt(stream.sample_rate ?? "0", 10);

  // nb_samples is the most accurate — direct sample count from the container
  if (stream.nb_samples !== undefined) {
    return {
      durationSamples: stream.nb_samples,
      sampleRate,
      ffprobeVersion,
    };
  }

  // Fallback: use duration_ts (in stream timebase units = samples for WAV)
  if (stream.duration_ts !== undefined) {
    return {
      durationSamples: stream.duration_ts,
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
    // Basic sanity check — durationSamples must be a positive integer
    if (typeof parsed.durationSamples !== "number" || parsed.durationSamples <= 0) {
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

  constructor(adapter: TtsAdapter, cacheDir: string, options: CacheOptions = {}) {
    this.adapter = adapter;
    this.cacheDir = cacheDir;
    this.noCache = options.noCache ?? false;
  }

  /**
   * Get cached audio for the request, synthesizing if necessary.
   * Returns the WAV path and sidecar duration (never a re-probe on hit).
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
        };
      }
      // Sidecar missing or corrupt: fall through to miss path
    }

    // Miss path: synthesize → write tmp → ffprobe → write sidecar → rename
    const result = await this.adapter.synth(normalizedReq);

    // Write f32le WAV to .tmp (overwrites any pre-existing .tmp)
    const wavBuffer = buildF32leWav(result.pcm, result.sampleRate);
    await writeFile(tmpPath, wavBuffer);

    // ffprobe measures the real duration from the file
    const { durationSamples, sampleRate, ffprobeVersion } = await probeDuration(tmpPath);

    // Write sidecar JSON
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

    return { wavPath, durationSamples, sampleRate };
  }
}
