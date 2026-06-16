// ffmpeg runner — side-effect layer for the compiler.
// Writes the filter-complex script to a temp file, invokes ffmpeg via execFile
// (never a shell string — no injection surface), and returns exit + stderr.
// §2: "Direct control over argv, exit codes, and the -filter_complex_script file path"

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { CompileResult } from "./index.js";

const execFileAsync = promisify(execFile);

export interface RunResult {
  exitCode: number;
  stderr: string;
  /**
   * Path to the temp filter-complex script when keepScript=true (caller must
   * delete it).  null when keepScript=false (the file has already been deleted).
   */
  scriptPath: string | null;
}

/**
 * Write the filter-complex script to a temp file and invoke ffmpeg.
 * The -filter_complex_script flag is inserted between -i flags and output options.
 *
 * @param compiled  result of compileIR
 * @param keepScript  when true, the caller is responsible for deleting the script file
 */
export async function runFfmpeg(
  compiled: CompileResult,
  keepScript = false,
): Promise<RunResult> {
  // Write filter-complex script to a named temp file (not argv string — avoids
  // argv length limits and shell-quoting hazards; §5.4 key decision).
  const scriptPath = join(
    tmpdir(),
    `soundstage-fc-${randomBytes(8).toString("hex")}.txt`,
  );

  await writeFile(scriptPath, compiled.filterScript, { encoding: "utf8", mode: 0o600 });

  // Build full argv: [-i ...] [-filter_complex_script <path>] [output opts...]
  // Splice -filter_complex_script before the output options (after all -i flags).
  // The argv from compileIR is: [-i file, -i file, ..., -map, ..., outPath]
  // We find the first non-i-related flag to split.
  const { argv } = compiled;
  const splitIdx = findOutputStart(argv);
  const fullArgv = [
    ...argv.slice(0, splitIdx),
    "-filter_complex_script", scriptPath,
    ...argv.slice(splitIdx),
  ];

  let exitCode = 0;
  let stderr = "";

  try {
    await execFileAsync("ffmpeg", fullArgv, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  } catch (err: unknown) {
    exitCode = 1;
    if (
      err !== null &&
      typeof err === "object" &&
      "stderr" in err &&
      typeof (err as { stderr: unknown }).stderr === "string"
    ) {
      stderr = (err as { stderr: string }).stderr;
      const code = (err as { code?: unknown }).code;
      if (typeof code === "number") {
        exitCode = code;
      }
    } else {
      stderr = err instanceof Error ? err.message : String(err);
    }
  }

  if (!keepScript) {
    await rm(scriptPath, { force: true });
    return { exitCode, stderr, scriptPath: null };
  }

  return { exitCode, stderr, scriptPath };
}

/**
 * Detect the index in argv where output options start (first flag that isn't -i or a file path).
 * compileIR builds argv as: [-i path, -i path, ..., -map, -c:a, ...]
 * We skip -i pairs and find the first non-i-pair entry.
 */
function findOutputStart(argv: string[]): number {
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === "-i") {
      i += 2; // skip -i + path
    } else {
      break;
    }
  }
  return i;
}

// ---------------------------------------------------------------------------
// Convenience: detect ffmpeg version (memoized)
// ---------------------------------------------------------------------------

let versionPromise: Promise<string> | undefined;

/** Return the ffmpeg version string (memoized per process). */
export function getFfmpegVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = execFileAsync("ffmpeg", ["-version"], { encoding: "utf8" }).then(
      ({ stdout }) => {
        const firstLine = stdout.split("\n")[0]?.trim() ?? "unknown";
        // Parse "ffmpeg version 8.1.1 ..." → "8.1.1"
        const match = firstLine.match(/ffmpeg version (\S+)/);
        return match?.[1] ?? firstLine;
      },
    );
  }
  return versionPromise;
}
