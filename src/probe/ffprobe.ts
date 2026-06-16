// Shared ffprobe exec+parse helper.
// Used by probe/index.ts (file duration) and adapters/cache/index.ts (WAV sidecar).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FfprobeStream {
  nb_samples?: number | string;
  sample_rate?: number | string;
  duration_ts?: number | string;
  duration?: number | string;
}

export interface FfprobeOutput {
  streams: FfprobeStream[];
}

export interface FfprobeStreamFields {
  nbSamples: number | undefined;   // integer sample count or undefined
  sampleRate: number;              // integer, 0 if absent/invalid
  durationTs: number | undefined;  // integer or undefined (PCM-WAV timebase units)
  durationSec: number | undefined; // float seconds or undefined (all containers)
}

/**
 * Run ffprobe on `filePath` requesting the given stream entries, parse the JSON output,
 * and return the first audio stream's fields coerced to numbers.
 *
 * Throws with a clear message including the file path on any failure:
 *   - ffprobe process error
 *   - JSON.parse failure (stdout not valid JSON)
 *   - No streams found in output
 */
export async function runFfprobe(
  filePath: string,
  showEntries: string,
): Promise<FfprobeStreamFields> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", showEntries,
        "-of", "json",
        filePath,
      ],
      { encoding: "utf8" },
    ) as { stdout: string; stderr: string };
    stdout = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ffprobe: process error for ${filePath}: ${msg}`);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new Error(`ffprobe: invalid JSON output for ${filePath}`);
  }

  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new Error(`ffprobe: no audio stream found in ${filePath}`);
  }

  // Coerce nb_samples — integer sample count (present in WAV, usually absent in mp3/aac)
  let nbSamples: number | undefined;
  if (stream.nb_samples !== undefined) {
    const v = typeof stream.nb_samples === "string"
      ? parseInt(stream.nb_samples, 10)
      : Math.trunc(stream.nb_samples);
    if (Number.isInteger(v) && v > 0) nbSamples = v;
  }

  // Coerce sample_rate
  const sampleRate = typeof stream.sample_rate === "string"
    ? parseInt(stream.sample_rate, 10)
    : typeof stream.sample_rate === "number"
      ? Math.trunc(stream.sample_rate)
      : 0;

  // Coerce duration_ts — valid for PCM-WAV only; integer timebase units
  let durationTs: number | undefined;
  if (stream.duration_ts !== undefined) {
    const v = typeof stream.duration_ts === "string"
      ? parseInt(stream.duration_ts, 10)
      : Math.trunc(stream.duration_ts as number);
    if (Number.isInteger(v) && v > 0) durationTs = v;
  }

  // Coerce duration — float seconds, valid for all containers
  let durationSec: number | undefined;
  if (stream.duration !== undefined) {
    const v = typeof stream.duration === "string"
      ? parseFloat(stream.duration)
      : Number(stream.duration);
    if (Number.isFinite(v) && v > 0) durationSec = v;
  }

  return { nbSamples, sampleRate, durationTs, durationSec };
}
