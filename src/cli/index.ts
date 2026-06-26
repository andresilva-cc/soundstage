#!/usr/bin/env node
// CLI entry point — commander-based `render` command.
// §6: npx soundstage render <file.tsx> [--out <dir>] [--no-cache] [--draft|--final]

import { Command } from "commander";
import { dirname, resolve, basename, extname, join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadTsx } from "./loader.js";
import { phaseA } from "../ir/phase-a.js";
import { phaseB } from "../ir/phase-b.js";
import { SoundstageError } from "../ir/errors.js";
import { CacheLayer } from "../adapters/cache/index.js";
import { SyntheticAdapter } from "../adapters/synthetic/index.js";
import { compileIR } from "../compiler/index.js";
import { runFfmpeg, getFfmpegVersion } from "../compiler/run.js";
import { applyLoudnorm } from "../compiler/loudnorm.js";
import { encodeMp3 } from "../compiler/encode.js";
import { runChapterPostPass } from "../compiler/chapters.js";
import { buildCacheReport, formatCacheReport } from "./report.js";

// ---------------------------------------------------------------------------
// Exit codes (§4.6)
// ---------------------------------------------------------------------------

const EXIT_USER_ERROR = 1;
const EXIT_ADAPTER_ERROR = 2;
const EXIT_FFMPEG_ERROR = 3;

// ---------------------------------------------------------------------------
// Adapter selection
// ---------------------------------------------------------------------------

/** Adapter mode: synthetic (--draft) or Kokoro (--final / default). */
type AdapterMode = "draft" | "final";

function selectAdapter(mode: AdapterMode) {
  if (mode === "draft") {
    return new SyntheticAdapter();
  }

  // "final" → Kokoro (lazy-loaded; throws a clear error if kokoro-js not installed).
  // Import KokoroAdapter lazily so that --draft/synthetic paths never load the module.
  // The adapter itself lazy-loads kokoro-js on first synth() — we just need the class.
  return import("../adapters/kokoro/index.js").then(
    ({ KokoroAdapter }) => new KokoroAdapter(),
  );
}

// ---------------------------------------------------------------------------
// Cache dir
// ---------------------------------------------------------------------------

function cacheDir(baseDir: string): string {
  return join(baseDir, ".soundstage", "cache");
}

// ---------------------------------------------------------------------------
// Error handling helpers
// ---------------------------------------------------------------------------

function printError(message: string): void {
  process.stderr.write(message + "\n");
}

// Error codes that map to user/composition errors (exit 1).
const USER_ERROR_CODES = new Set([
  "E_MISSING_PROP",
  "E_CROSSFADE_BOUNDARY",
  "E_SRC_NOT_FOUND",
  "E_CROSSFADE_DURATION",
  "E_INVALID_PROP",
  "E_MAX_DEPTH",
  "E_ARTWORK_NOT_FOUND",
  "E_NO_DEFAULT_EXPORT",
]);

// Error codes that map to adapter/synthesis errors (exit 2).
const ADAPTER_ERROR_CODES = new Set<string>([]);

// Error codes that map to ffmpeg/ffprobe errors (exit 3).
const FFMPEG_ERROR_CODES = new Set<string>([]);

function handleError(err: unknown): never {
  if (err instanceof SoundstageError) {
    printError(err.message);
    if (USER_ERROR_CODES.has(err.code)) {
      process.exit(EXIT_USER_ERROR);
    }
    if (ADAPTER_ERROR_CODES.has(err.code)) {
      process.exit(EXIT_ADAPTER_ERROR);
    }
    if (FFMPEG_ERROR_CODES.has(err.code)) {
      process.exit(EXIT_FFMPEG_ERROR);
    }
    // Fallback for any future codes not yet classified.
    process.exit(EXIT_USER_ERROR);
  }

  if (err instanceof Error) {
    // Adapter/model errors — identified by error origin, not message substring.
    // These are plain Error instances thrown by adapter internals (kokoro-js failures).
    const isAdapterError =
      err.constructor.name === "AdapterError" ||
      err.message.startsWith("kokoro-js is not installed") ||
      err.message.startsWith("from_pretrained");
    if (isAdapterError) {
      printError(`soundstage: error[E_ADAPTER]: ${err.message}`);
      process.exit(EXIT_ADAPTER_ERROR);
    }

    // ffmpeg/ffprobe errors — thrown by run.ts / loudnorm.ts / encode.ts.
    // Identified by the fixed prefix these modules use, not freeform substring.
    const isffmpegError =
      err.message.startsWith("ffmpeg") ||
      err.message.startsWith("ffprobe") ||
      err.message.startsWith("soundstage: error[E_FFMPEG]") ||
      err.message.includes("mix pass failed") ||
      err.message.startsWith("loudnorm") ||
      err.message.startsWith("mp3 encode failed");
    if (isffmpegError) {
      printError(`soundstage: error[E_FFMPEG]: ${err.message}`);
      process.exit(EXIT_FFMPEG_ERROR);
    }

    // Generic error → user error
    printError(`soundstage: error: ${err.message}`);
    process.exit(EXIT_USER_ERROR);
  }

  printError(`soundstage: unexpected error: ${String(err)}`);
  process.exit(EXIT_USER_ERROR);
}

// ---------------------------------------------------------------------------
// Render command implementation
// ---------------------------------------------------------------------------

interface RenderOptions {
  out?: string;
  cache: boolean;   // commander's --no-cache sets this to false
  draft: boolean;
  final: boolean;
}

async function runRender(filePath: string, opts: RenderOptions): Promise<void> {
  const absFile = resolve(filePath);
  const baseDir = dirname(absFile);
  const stem = basename(absFile, extname(absFile));
  const outDir = opts.out !== undefined ? resolve(opts.out) : baseDir;
  const noCache = !opts.cache;

  // Determine adapter mode: --draft = synthetic, --final = Kokoro, default = Kokoro.
  const mode: AdapterMode = opts.draft ? "draft" : "final";

  // Select adapter (may be a Promise for Kokoro).
  const adapterRaw = selectAdapter(mode);
  const adapter =
    adapterRaw instanceof Promise
      ? await adapterRaw.catch((err: unknown) => {
          handleError(err);
        })
      : adapterRaw;
  if (adapter === undefined) {
    // handleError already exited; this is unreachable but satisfies TypeScript.
    process.exit(EXIT_ADAPTER_ERROR);
  }

  // Ensure cache dir exists.
  const cacheDirPath = cacheDir(baseDir);
  await mkdir(cacheDirPath, { recursive: true });

  // Build CacheLayer.
  const cache = new CacheLayer(adapter, cacheDirPath, { noCache });

  // Tracking for cache report.
  const hitVoiceUnitIds = new Set<number>();
  let totalVoices = 0;
  function onVoiceSynthesized(voiceUnitId: number, hit: boolean): void {
    totalVoices = Math.max(totalVoices, voiceUnitId + 1);
    if (hit) hitVoiceUnitIds.add(voiceUnitId);
  }

  // 1. Load .tsx → element tree.
  let tree;
  try {
    tree = await loadTsx(absFile);
  } catch (err) {
    handleError(err);
  }

  // 2. validateTree (sole resolve+validate entry) + Phase A (synthesize/cache).
  let resolvedTree;
  try {
    resolvedTree = await phaseA(tree, {
      cache,
      baseDir,
      onVoiceSynthesized,
    });
  } catch (err) {
    handleError(err);
  }

  // 3. Phase B → IR.
  let ir;
  try {
    ir = phaseB(resolvedTree);
  } catch (err) {
    handleError(err);
  }

  // 4. Populate IR.render.ffmpegVersion + outputs.
  let ffmpegVersion: string;
  try {
    ffmpegVersion = await getFfmpegVersion();
  } catch (err) {
    handleError(err);
  }
  ir.render.ffmpegVersion = ffmpegVersion;

  // Ensure output directory exists.
  await mkdir(outDir, { recursive: true });

  const wavPath = join(outDir, `${stem}.wav`);
  const mp3Path = join(outDir, `${stem}.mp3`);
  ir.render.outputs = ["wav", "mp3"];

  // Use a temp dir for intermediate files (mix, loudnorm pass).
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "soundstage-render-"));
    const mixPath = join(tmpDir, "mix.f32.wav");

    // 5. Compile IR → ffmpeg filter graph + run mix pass.
    let compiled;
    try {
      compiled = compileIR(ir, mixPath);
    } catch (err) {
      handleError(err);
    }

    const mixResult = await runFfmpeg(compiled);
    if (mixResult.exitCode !== 0) {
      printError(
        `soundstage: error[E_FFMPEG]: mix pass failed (exit ${mixResult.exitCode}):\n${mixResult.stderr.slice(-2000)}`,
      );
      process.exit(EXIT_FFMPEG_ERROR);
    }

    // 6. Two-pass loudnorm → WAV master.
    try {
      await applyLoudnorm(mixPath, ir.loudness, ir.sampleRate, wavPath);
    } catch (err) {
      handleError(err);
    }

    // 7. Encode mp3.
    try {
      await encodeMp3(wavPath, mp3Path);
    } catch (err) {
      handleError(err);
    }

    // 8. node-id3 chapter + artwork post-pass.
    try {
      await runChapterPostPass(ir, mp3Path, wavPath);
    } catch (err) {
      handleError(err);
    }
  } finally {
    if (tmpDir !== undefined) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  // 9. Print cache report.
  const report = buildCacheReport(ir, hitVoiceUnitIds, totalVoices);
  process.stdout.write("soundstage: cache report\n");
  process.stdout.write(formatCacheReport(report) + "\n");

  // 10. Success message.
  process.stdout.write(
    `soundstage: render complete → ${stem}.wav, ${stem}.mp3\n`,
  );
}

// ---------------------------------------------------------------------------
// Commander program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("soundstage")
  .description("Audio as Code — compose narrated audio episodes with JSX/TSX")
  .version("0.1.0");

program
  .command("render <file>")
  .description("Render a .tsx episode file to WAV + mp3")
  .option("--out <dir>", "Output directory (default: same as source file)")
  .option("--no-cache", "Bypass cache reads (always re-synth; still writes entries)")
  .option("--draft", "Use the synthetic adapter (fast, no model download)")
  .option("--final", "Use the Kokoro adapter (real voice; requires kokoro-js)")
  .action(async (file: string, opts: RenderOptions) => {
    // Validate flag combinations.
    if (opts.draft && opts.final) {
      printError("soundstage: error: --draft and --final are mutually exclusive");
      process.exit(EXIT_USER_ERROR);
    }

    try {
      await runRender(file, opts);
    } catch (err) {
      handleError(err);
    }
  });

program.parse(process.argv);
