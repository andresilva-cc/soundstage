// ffprobe helpers for Phase A and the compiler (OD-7: lives here so ir/ doesn't import compiler/).
// Probes are memoized in-process by (absPath, mtimeNs, size) to avoid re-probing the same file.

import { stat } from "node:fs/promises";
import * as ffprobeModule from "./ffprobe.js";

export interface ProbeResult {
  durationSamples: number;
  sampleRate: number;
}

/** Maximum probe memo entries — evicts oldest when exceeded. */
const PROBE_CACHE_MAX = 1000;

/** In-process probe memo — cleared between test runs via clearProbeCache(). */
const probeCache = new Map<string, ProbeResult>();

/** Clear the in-process probe memo (for tests). */
export function clearProbeCache(): void {
  probeCache.clear();
}

// Memoization key: absPath + mtimeNs (bigint as string) + size (bigint as string)
function memoKey(absPath: string, mtimeNs: bigint, size: bigint): string {
  return `${absPath}\x00${mtimeNs.toString()}\x00${size.toString()}`;
}

/**
 * Probe an audio file's duration in samples using ffprobe.
 * Memoized in-process by (absPath, mtimeNs, size).
 * Supports WAV (nb_samples), MP3/AAC (duration × sample_rate).
 */
export async function probeFileDuration(absPath: string): Promise<ProbeResult> {
  const stats = await stat(absPath, { bigint: true });
  const key = memoKey(absPath, stats.mtimeNs, stats.size);

  const cached = probeCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const fields = await ffprobeModule.runFfprobe(absPath, "stream=nb_samples,sample_rate,duration_ts,duration");

  const { nbSamples, sampleRate, durationSec } = fields;

  let durationSamples: number | undefined;

  // nb_samples is the most direct — integer sample count from container (WAV)
  if (nbSamples !== undefined) {
    durationSamples = nbSamples;
  }

  // Fallback: duration (float seconds) × sample_rate — works for any container (mp3, aac, etc.)
  if (durationSamples === undefined && durationSec !== undefined && sampleRate > 0) {
    durationSamples = Math.round(durationSec * sampleRate);
  }

  if (durationSamples === undefined || durationSamples <= 0) {
    throw new Error(`ffprobe: could not determine duration for ${absPath}`);
  }

  const result: ProbeResult = { durationSamples, sampleRate };

  // Cap memo size — evict oldest entry when at limit
  if (probeCache.size >= PROBE_CACHE_MAX) {
    const firstKey = probeCache.keys().next().value;
    if (firstKey !== undefined) probeCache.delete(firstKey);
  }
  probeCache.set(key, result);
  return result;
}
