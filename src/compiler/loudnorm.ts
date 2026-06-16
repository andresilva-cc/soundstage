// Two-pass loudnorm — §5.5.
// Pass 1: measure; Pass 2: apply measured values + linear=true + explicit -ar.
// Loudnorm is NEVER applied per-segment and NEVER inside the mix filter graph.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoudnormTargets {
  targetI: number;
  targetTP: number;
  targetLRA: number;
}

export interface MeasuredValues {
  measured_I: string;
  measured_TP: string;
  measured_LRA: string;
  measured_thresh: string;
  offset: string;
}

export interface Pass2Argv {
  argv: string[];
}

// ---------------------------------------------------------------------------
// Pass 1: measure
// ---------------------------------------------------------------------------

/**
 * Run loudnorm in analysis mode on the intermediate mix file.
 * Parses the JSON block from ffmpeg stderr and returns measured values.
 *
 * Exact invocation (§5.5):
 *   ffmpeg -i mix.f32.wav -af loudnorm=I=<I>:TP=<TP>:LRA=<LRA>:print_format=json -f null -
 */
export async function measureLoudnorm(
  mixPath: string,
  targets: LoudnormTargets,
): Promise<MeasuredValues> {
  const { targetI, targetTP, targetLRA } = targets;
  const filter = `loudnorm=I=${targetI}:TP=${targetTP}:LRA=${targetLRA}:print_format=json`;

  // ffmpeg may exit 0 or non-zero when writing to -f null - ; either way the
  // JSON block is always in stderr. Capture stderr from both paths.
  let stderr = "";
  try {
    const result = await execFileAsync(
      "ffmpeg",
      ["-y", "-i", mixPath, "-af", filter, "-f", "null", "-"],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    ) as { stderr: string };
    stderr = result.stderr;
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "stderr" in err &&
      typeof (err as { stderr: unknown }).stderr === "string"
    ) {
      stderr = (err as { stderr: string }).stderr;
    } else {
      throw err;
    }
  }

  // Parse the JSON block emitted to stderr by loudnorm:print_format=json.
  // The summary JSON block always appears at the END of stderr; metadata headers
  // may also emit JSON-like blocks earlier. Use the LAST match.
  const allJsonMatches = [...stderr.matchAll(/\{[^{}]*\}/gs)];
  const lastMatch = allJsonMatches[allJsonMatches.length - 1];
  if (!lastMatch) {
    throw new Error(
      `loudnorm pass 1: could not parse JSON from ffmpeg stderr.\nstderr: ${stderr.slice(-2000)}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(lastMatch[0]) as Record<string, unknown>;
  } catch {
    throw new Error(
      `loudnorm pass 1: JSON.parse failed on: ${lastMatch[0]}`,
    );
  }

  // Capture the matched block for error messages below.
  const jsonBlock = lastMatch[0];

  // ffmpeg ≤ 4.x used "measured_I" / "measured_TP" etc. as key names.
  // ffmpeg 5.x+ changed the output keys to "input_i" / "input_tp" etc.
  // Both field sets carry the same semantics — map both to our MeasuredValues shape.
  function getField(newKey: string, legacyKey: string): string {
    const v = parsed[newKey] ?? parsed[legacyKey];
    if (typeof v !== "string") {
      throw new Error(
        `loudnorm pass 1: missing or non-string field "${newKey}" (also tried "${legacyKey}") in JSON: ${jsonBlock}`,
      );
    }
    return v;
  }

  return {
    measured_I: getField("input_i", "measured_I"),
    measured_TP: getField("input_tp", "measured_TP"),
    measured_LRA: getField("input_lra", "measured_LRA"),
    measured_thresh: getField("input_thresh", "measured_thresh"),
    offset: getField("target_offset", "offset"),
  };
}

// ---------------------------------------------------------------------------
// Pass 2: build argv for apply + WAV encode
// ---------------------------------------------------------------------------

/**
 * Build the argv for loudnorm pass 2 (apply measured values, linear=true).
 * Writes to outWavPath with -bitexact.
 *
 * Exact invocation (§5.5):
 *   ffmpeg -bitexact -i mix.f32.wav \
 *     -af loudnorm=I=<I>:TP=<TP>:LRA=<LRA>:measured_I=<>:...linear=true:print_format=summary \
 *     -ar <rate> -bitexact <master.wav>
 */
// Matches a number or "-inf" as produced by loudnorm JSON output.
const LOUDNORM_NUMERIC = /^-?(?:\d+(?:\.\d*)?|\.\d+)$|^-inf$/i;

function validateMeasuredField(name: string, value: string): void {
  if (!LOUDNORM_NUMERIC.test(value.trim())) {
    throw new Error(
      `loudnorm pass 2: measured field "${name}" has unexpected value "${value}" — parse may be corrupt`,
    );
  }
}

export function buildPass2Argv(
  mixPath: string,
  measured: MeasuredValues,
  targets: LoudnormTargets,
  sampleRate: number,
  outWavPath: string,
): string[] {
  const { targetI, targetTP, targetLRA } = targets;
  const { measured_I, measured_TP, measured_LRA, measured_thresh, offset } = measured;

  validateMeasuredField("measured_I", measured_I);
  validateMeasuredField("measured_TP", measured_TP);
  validateMeasuredField("measured_LRA", measured_LRA);
  validateMeasuredField("measured_thresh", measured_thresh);
  validateMeasuredField("offset", offset);

  const filter =
    `loudnorm=I=${targetI}:TP=${targetTP}:LRA=${targetLRA}` +
    `:measured_I=${measured_I}:measured_TP=${measured_TP}` +
    `:measured_LRA=${measured_LRA}:measured_thresh=${measured_thresh}` +
    `:offset=${offset}:linear=true:print_format=summary`;

  return [
    "-bitexact",
    "-i", mixPath,
    "-af", filter,
    "-ar", String(sampleRate),
    "-c:a", "pcm_s16le",
    "-f", "wav",
    "-bitexact",
    "-y",
    "--",
    outWavPath,
  ];
}

// ---------------------------------------------------------------------------
// Full two-pass loudnorm: measure then apply, writing the WAV master.
// ---------------------------------------------------------------------------

export interface ApplyLoudnormResult {
  /** The measured loudnorm values from pass 1. */
  measured: MeasuredValues;
  /** The output WAV master path (outWavPath). */
  wavPath: string;
}

/**
 * Run both loudnorm passes on the intermediate mix and write the WAV master.
 * Returns measured values and the output WAV path for downstream pipeline stages.
 */
export async function applyLoudnorm(
  mixPath: string,
  targets: LoudnormTargets,
  sampleRate: number,
  outWavPath: string,
): Promise<ApplyLoudnormResult> {
  const measured = await measureLoudnorm(mixPath, targets);

  const argv = buildPass2Argv(mixPath, measured, targets, sampleRate, outWavPath);

  try {
    await execFileAsync("ffmpeg", argv, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const stderr =
      err !== null &&
      typeof err === "object" &&
      "stderr" in err &&
      typeof (err as { stderr: unknown }).stderr === "string"
        ? (err as { stderr: string }).stderr
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`loudnorm pass 2 failed:\n${stderr.slice(-2000)}`);
  }

  return { measured, wavPath: outWavPath };
}
