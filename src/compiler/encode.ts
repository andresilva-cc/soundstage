// mp3 encode pass — §5.5, issue #10.
// Encodes the loudnorm-processed WAV master to mp3.
// Called AFTER applyLoudnorm has produced master.wav.
// Note: -bitexact is passed to ffmpeg but is a no-op for libmp3lame; mp3 output
// is NOT byte-identical across renders. Only the WAV master carries that guarantee.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Build mp3 encode argv
// ---------------------------------------------------------------------------

/**
 * Build the argv for the mp3 encode step.
 * Exact invocation (issue #10):
 *   ffmpeg -bitexact -i master.wav -codec:a libmp3lame -q:a 2 episode.mp3
 * (-bitexact is passed for ffmpeg infra consistency; it is a no-op for libmp3lame)
 */
export function buildMp3Argv(inWavPath: string, outMp3Path: string): string[] {
  return [
    "-bitexact",
    "-i", inWavPath,
    "-codec:a", "libmp3lame",
    "-q:a", "2",
    "-y",
    "--",
    outMp3Path,
  ];
}

// ---------------------------------------------------------------------------
// Encode WAV → mp3
// ---------------------------------------------------------------------------

/**
 * Encode master.wav to episode.mp3 using libmp3lame.
 * Returns the output path (outMp3Path) for downstream pipeline stages.
 */
export async function encodeMp3(
  inWavPath: string,
  outMp3Path: string,
): Promise<string> {
  const argv = buildMp3Argv(inWavPath, outMp3Path);

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
    throw new Error(`mp3 encode failed:\n${stderr.slice(-2000)}`);
  }

  return outMp3Path;
}
