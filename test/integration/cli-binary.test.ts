// Child-process CLI integration test.
// Runs the BUILT binary (`node dist/cli/index.js`) in a subprocess to verify
// that real Node runtime module resolution works — i.e. the bundled temp .mjs
// can resolve `soundstage`/`soundstage/jsx-runtime` without vitest's alias.
//
// Gate: skips if dist/cli/index.js is absent (run `npm run build` first).
// The hermetic gate `rm -rf dist && npm run build && NO_KOKORO=1 npm test`
// satisfies this precondition before the test suite runs.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const WORKTREE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI_ENTRY = join(WORKTREE_ROOT, "dist", "cli", "index.js");
const FIXTURE = join(WORKTREE_ROOT, "test", "fixtures", "episodes", "simple.tsx");
const FIXTURE_INVALID = join(WORKTREE_ROOT, "test", "fixtures", "episodes", "invalid.tsx");

const distExists = existsSync(CLI_ENTRY);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ffprobeStream(filePath: string): Promise<{
  codec: string;
  sampleRate: string;
  duration: string;
}> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,sample_rate,duration",
    "-of", "default=noprint_wrappers=1",
    filePath,
  ], { encoding: "utf8" });

  const get = (key: string): string =>
    stdout.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() ?? "";

  return {
    codec: get("codec_name"),
    sampleRate: get("sample_rate"),
    duration: get("duration"),
  };
}

/** Run the CLI binary with given args. Returns stdout, stderr, and exit code.
 *  Never throws — resolves with exit code even on non-zero exits. */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { encoding: "utf8", timeout: 60_000 },
      (err, stdout, stderr) => {
        // execFile sets err.code to the exit code for non-zero exits.
        // But the type is the system error code for syscall errors — for child
        // process exits the actual exit code is on err.code when it's a number.
        const exitCode =
          err !== null && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : 0;
        resolve({ stdout: stdout as string, stderr: stderr as string, code: exitCode });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let outDir: string;

beforeAll(async () => {
  if (!distExists) return;
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-binary-test-"));
  outDir = join(tmpDir, "out");
});

afterAll(async () => {
  if (tmpDir !== undefined) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)(
  "CLI binary (real Node subprocess) — soundstage/jsx-runtime resolution",
  () => {
    let stdout: string;
    let stderr: string;

    beforeAll(async () => {
      // Run the built CLI in a child process (no vitest alias — real Node resolution).
      const result = await execFileAsync(
        process.execPath,
        [CLI_ENTRY, "render", FIXTURE, "--draft", "--out", outDir],
        { encoding: "utf8", timeout: 60_000 },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    }, 90_000);

    it("exits 0 (no unhandled error)", () => {
      // If execFileAsync threw, beforeAll would have failed — reaching here means exit 0.
      expect(stdout).toContain("soundstage: render complete");
    });

    it("produces a .wav file at the --out path", async () => {
      await expect(access(join(outDir, "simple.wav"))).resolves.toBeUndefined();
    });

    it("produces a .mp3 file at the --out path", async () => {
      await expect(access(join(outDir, "simple.mp3"))).resolves.toBeUndefined();
    });

    it(".wav is a valid PCM audio file at 48000 Hz", async () => {
      const info = await ffprobeStream(join(outDir, "simple.wav"));
      expect(info.codec).toBe("pcm_s16le");
      expect(info.sampleRate).toBe("48000");
      expect(parseFloat(info.duration)).toBeGreaterThan(0);
    });

    it(".mp3 is a valid audio file", async () => {
      const info = await ffprobeStream(join(outDir, "simple.mp3"));
      expect(info.codec).toBe("mp3");
      expect(parseFloat(info.duration)).toBeGreaterThan(0);
    });

    it("cache report is printed to stdout", () => {
      expect(stdout).toContain("soundstage: cache report");
      expect(stdout).toContain("Intro");
      expect(stdout).toContain("Outro");
    });

    it("no 'Cannot find package' errors in stderr", () => {
      expect(stderr).not.toContain("Cannot find package");
    });
  },
);

// ---------------------------------------------------------------------------
// Cache hit on second run (binary subprocess)
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)(
  "CLI binary — second render shows cache HITs in stdout",
  () => {
    let secondStdout: string;

    beforeAll(async () => {
      const cacheOutDir = join(tmpDir, "cache-hit-out");
      await mkdir(cacheOutDir, { recursive: true });

      // First run: cold cache — populates cache.
      await execFileAsync(
        process.execPath,
        [CLI_ENTRY, "render", FIXTURE, "--draft", "--out", cacheOutDir],
        { encoding: "utf8", timeout: 60_000 },
      );

      // Second run: warm cache — should show HITs.
      const second = await execFileAsync(
        process.execPath,
        [CLI_ENTRY, "render", FIXTURE, "--draft", "--out", cacheOutDir],
        { encoding: "utf8", timeout: 60_000 },
      );
      secondStdout = second.stdout;
    }, 120_000);

    it("second run reports cached voices (not re-synth)", () => {
      expect(secondStdout).toContain("cached");
      expect(secondStdout).not.toContain("re-synth ·");
    });

    it("second run total shows 2/2 cached", () => {
      expect(secondStdout).toContain("total: 2/2 cached");
    });
  },
);

// ---------------------------------------------------------------------------
// --no-cache forces re-synth but still produces valid output (binary)
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)(
  "CLI binary — --no-cache forces re-synth but produces valid output",
  () => {
    let noCacheStdout: string;
    let noCacheOutDir: string;

    beforeAll(async () => {
      noCacheOutDir = join(tmpDir, "no-cache-out");
      await mkdir(noCacheOutDir, { recursive: true });

      // Pre-warm the cache.
      await execFileAsync(
        process.execPath,
        [CLI_ENTRY, "render", FIXTURE, "--draft", "--out", noCacheOutDir],
        { encoding: "utf8", timeout: 60_000 },
      );

      // Run with --no-cache: should bypass reads, still produce output.
      const result = await execFileAsync(
        process.execPath,
        [CLI_ENTRY, "render", FIXTURE, "--draft", "--no-cache", "--out", noCacheOutDir],
        { encoding: "utf8", timeout: 60_000 },
      );
      noCacheStdout = result.stdout;
    }, 120_000);

    it("--no-cache run reports all re-synth (0 cache hits)", () => {
      expect(noCacheStdout).toContain("total: 0/2 cached");
    });

    it("--no-cache run still produces a valid .wav", async () => {
      const info = await ffprobeStream(join(noCacheOutDir, "simple.wav"));
      expect(info.codec).toBe("pcm_s16le");
      expect(parseFloat(info.duration)).toBeGreaterThan(0);
    });

    it("--no-cache run still produces a valid .mp3", async () => {
      const info = await ffprobeStream(join(noCacheOutDir, "simple.mp3"));
      expect(info.codec).toBe("mp3");
      expect(parseFloat(info.duration)).toBeGreaterThan(0);
    });
  },
);

// ---------------------------------------------------------------------------
// --out flag honored (binary)
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)(
  "CLI binary — --out writes output to specified directory",
  () => {
    let customOutDir: string;

    beforeAll(async () => {
      customOutDir = join(tmpDir, "custom-binary-out");
      await mkdir(customOutDir, { recursive: true });

      await execFileAsync(
        process.execPath,
        [CLI_ENTRY, "render", FIXTURE, "--draft", "--out", customOutDir],
        { encoding: "utf8", timeout: 60_000 },
      );
    }, 90_000);

    it("simple.wav is in --out directory", async () => {
      await expect(access(join(customOutDir, "simple.wav"))).resolves.toBeUndefined();
    });

    it("simple.mp3 is in --out directory", async () => {
      await expect(access(join(customOutDir, "simple.mp3"))).resolves.toBeUndefined();
    });
  },
);

// ---------------------------------------------------------------------------
// Exit-code test: invalid composition → exit 1, stderr has E_MISSING_PROP
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)(
  "CLI binary — exit-code classification (handleError routing)",
  () => {
    it("invalid composition exits 1 and stderr contains E_MISSING_PROP", async () => {
      const badOutDir = join(tmpDir, "bad-out");
      await mkdir(badOutDir, { recursive: true });

      const { code, stderr } = await runCli([
        "render", FIXTURE_INVALID, "--draft", "--out", badOutDir,
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain("E_MISSING_PROP");
    });
  },
);

// ---------------------------------------------------------------------------
// --provider flag behaviors (hermetic subprocess tests)
// ---------------------------------------------------------------------------

/** runCli variant that accepts a custom env map (inherits process.env by default). */
async function runCliEnv(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { encoding: "utf8", timeout: 60_000, env },
      (err, stdout, stderr) => {
        const exitCode =
          err !== null && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : 0;
        resolve({ stdout: stdout as string, stderr: stderr as string, code: exitCode });
      },
    );
  });
}

describe.skipIf(!distExists)(
  "CLI binary — --provider flag behaviors",
  () => {
    let providerOutDir: string;

    beforeAll(async () => {
      providerOutDir = join(tmpDir, "provider-out");
      await mkdir(providerOutDir, { recursive: true });
    });

    it("--final --provider unknown exits 1 with clear message and no doubled prefix", async () => {
      const { code, stderr } = await runCli([
        "render", FIXTURE, "--final", "--provider", "unknown-xyz", "--out", providerOutDir,
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("unknown-xyz");
      // The message must NOT contain a doubled "soundstage: error: soundstage: error:" prefix.
      expect(stderr).not.toMatch(/soundstage: error:.*soundstage: error:/s);
    });

    it("--draft --provider openai emits warning on stderr and exits 0 with synthetic output", async () => {
      const draftOutDir = join(tmpDir, "draft-provider-out");
      await mkdir(draftOutDir, { recursive: true });

      const { code, stderr, stdout } = await runCli([
        "render", FIXTURE, "--draft", "--provider", "openai", "--out", draftOutDir,
      ]);

      expect(code).toBe(0);
      expect(stderr).toContain("warning");
      expect(stderr).toContain("--provider");
      expect(stdout).toContain("soundstage: render complete");
    }, 90_000);

    it("--final --provider openai with no API key exits 2 (E_ADAPTER_MISSING_KEY)", async () => {
      // Build a subprocess env without OPENAI_API_KEY so the adapter throws E_ADAPTER_MISSING_KEY.
      // This is hermetic — the adapter checks the key before any network call.
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env["OPENAI_API_KEY"];

      const noKeyOutDir = join(tmpDir, "no-key-out");
      await mkdir(noKeyOutDir, { recursive: true });

      const { code, stderr } = await runCliEnv(
        ["render", FIXTURE, "--final", "--provider", "openai", "--out", noKeyOutDir],
        env,
      );

      expect(code).toBe(2);
      expect(stderr).toContain("OPENAI_API_KEY");
    }, 90_000);
  },
);
