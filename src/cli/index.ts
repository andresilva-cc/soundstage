#!/usr/bin/env node
// CLI entry point — commander-based `render` command.
// §6: npx soundstage render <file.tsx> [--out <dir>] [--no-cache] [--draft|--final]

import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename, extname, join } from "node:path";
import { mkdtemp, rm, mkdir, access, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadTsx } from "./loader.js";
import { phaseA } from "../ir/phase-a.js";
import { phaseB } from "../ir/phase-b.js";
import { SoundstageError } from "../ir/errors.js";
import { CacheLayer } from "../adapters/cache/index.js";
import { selectAdapter } from "./select-adapter.js";
import type { AdapterMode } from "./select-adapter.js";
import { compileIR } from "../compiler/index.js";
import { runFfmpeg, getFfmpegVersion } from "../compiler/run.js";
import { applyLoudnorm } from "../compiler/loudnorm.js";
import { encodeMp3 } from "../compiler/encode.js";
import { runChapterPostPass } from "../compiler/chapters.js";
import { buildCacheReport, formatCacheReport } from "./report.js";
import { generateWaveform, generatePlayer } from "../compiler/player.js";
import { readRenderState, writeRenderState, hashIR } from "./render-state.js";
import { extractVoiceTexts, generateTranscriptCues, formatSrt, formatVtt, formatTxt } from "../compiler/transcript.js";
import { validateFeedConfig, buildFeedXml } from "../compiler/feed.js";
import type { EpisodeMeta } from "../compiler/feed.js";
import { probeFileDuration } from "../probe/index.js";

// ---------------------------------------------------------------------------
// Exit codes (§4.6)
// ---------------------------------------------------------------------------

const EXIT_USER_ERROR = 1;
const EXIT_ADAPTER_ERROR = 2;
const EXIT_FFMPEG_ERROR = 3;

// ---------------------------------------------------------------------------
// Adapter selection
// ---------------------------------------------------------------------------

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
const ADAPTER_ERROR_CODES = new Set<string>(["E_ADAPTER_MISSING_KEY", "E_ADAPTER_REQUEST_FAILED"]);

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
      err.message.startsWith("mp3 encode failed") ||
      err.message.startsWith("waveform generation failed");
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
  provider?: string; // --provider <kokoro|openai|elevenlabs>; only meaningful with --final
  player?: boolean; // --player generates waveform.png + <stem>-player.html
  force?: boolean; // --force bypasses the IR hash check (always re-renders)
  transcript?: boolean; // --transcript generates .srt, .vtt, .txt subtitle files
}

async function runRender(filePath: string, opts: RenderOptions): Promise<void> {
  const absFile = resolve(filePath);
  const baseDir = dirname(absFile);
  const stem = basename(absFile, extname(absFile));
  const outDir = opts.out !== undefined ? resolve(opts.out) : baseDir;
  const noCache = !opts.cache;

  // Determine adapter mode: --draft = synthetic, --final = real TTS, default = real TTS.
  const mode: AdapterMode = opts.draft ? "draft" : "final";
  const provider = opts.provider ?? null;

  // Select adapter. selectAdapter emits a warning if draft + provider is set.
  const adapter = await selectAdapter(mode, provider).catch(handleError);

  // Ensure cache dir exists.
  const cacheDirPath = cacheDir(baseDir);
  await mkdir(cacheDirPath, { recursive: true });

  // Build CacheLayer.
  const cache = new CacheLayer(adapter, cacheDirPath, { noCache });

  // Tracking for cache report (T7: per-chunk stats).
  const chunkStats = new Map<number, { total: number; hits: number }>();
  function onVoiceSynthesized(voiceUnitId: number, _chunkIndex: number, _chunkTotal: number, hit: boolean): void {
    const stats = chunkStats.get(voiceUnitId) ?? { total: 0, hits: 0 };
    stats.total++;
    if (hit) stats.hits++;
    chunkStats.set(voiceUnitId, stats);
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

  // Extract original authored text per voice unit for transcript generation (T1).
  // Called after phaseA (resolvedTree has originalText on each ChunkResult) and
  // before phaseB so the resolved tree is still in scope.
  const voiceTexts = extractVoiceTexts(resolvedTree);

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

  // 4.5. Streaming skip check — AFTER ffmpegVersion is set (determinism boundary).
  // Hash includes ffmpegVersion so a binary upgrade correctly busts the skip.
  const irHash = hashIR(ir);
  if (!opts.force) {
    const state = await readRenderState(outDir);
    if (state?.ir_hash === irHash) {
      let outputsExist = true;
      try {
        await access(wavPath);
        await access(mp3Path);
      } catch {
        outputsExist = false;
      }
      if (outputsExist) {
        // Phase A already ran — print cache report before returning so callers
        // can see TTS hit/miss stats even on a skipped (streaming) render.
        const skipReport = buildCacheReport(ir, chunkStats);
        process.stdout.write("soundstage: cache report\n");
        process.stdout.write(formatCacheReport(skipReport) + "\n");

        // Player artifacts are cheap and idempotent — regenerate from the
        // existing mp3 even on a skip so --player is never silently absent.
        let skipPlayerOutputs = "";
        if (opts.player) {
          let waveformPath: string;
          try {
            waveformPath = await generateWaveform(mp3Path, outDir);
          } catch (err) {
            handleError(err);
          }
          try {
            await generatePlayer(ir, mp3Path, waveformPath, outDir);
          } catch (err) {
            handleError(err);
          }
          skipPlayerOutputs = `, ${stem}-player.html, waveform.png`;
        }

        // Transcript artifacts are fast/pure — regenerate from in-memory data on skip.
        // Errors are non-fatal: the skip already reported outputs up to date.
        let skipTranscriptOutputs = "";
        if (opts.transcript) {
          try {
            const cues = generateTranscriptCues(ir, voiceTexts);
            await writeFile(join(outDir, `${stem}.srt`), formatSrt(cues, ir.sampleRate));
            await writeFile(join(outDir, `${stem}.vtt`), formatVtt(cues, ir.sampleRate));
            await writeFile(join(outDir, `${stem}.txt`), formatTxt(ir, cues));
            skipTranscriptOutputs = `, ${stem}.srt, ${stem}.vtt, ${stem}.txt`;
          } catch (transcriptErr) {
            printError(
              `soundstage: warning: could not generate transcript files: ${transcriptErr instanceof Error ? transcriptErr.message : String(transcriptErr)}`,
            );
          }
        }

        process.stdout.write(
          `soundstage: no changes — outputs up to date${skipPlayerOutputs}${skipTranscriptOutputs}\n`,
        );
        return;
      }
    }
  }

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

    // 8.5. Write render state — records irHash so unchanged re-runs are skipped.
    // A failed write is non-fatal: log a warning and continue. The render is
    // already complete; a missing state file just means the next run re-renders.
    try {
      await writeRenderState(outDir, irHash);
    } catch (stateErr) {
      printError(
        `soundstage: warning: could not write render-state.json: ${stateErr instanceof Error ? stateErr.message : String(stateErr)}`,
      );
    }

    // 8.6. (Optional) Generate subtitle/transcript files when --transcript is set.
    // Pure text from in-memory data — no ffmpeg, no network. Errors are
    // non-fatal (the render is already complete; wav/mp3 are written).
    if (opts.transcript) {
      try {
        const cues = generateTranscriptCues(ir, voiceTexts);
        await writeFile(join(outDir, `${stem}.srt`), formatSrt(cues, ir.sampleRate));
        await writeFile(join(outDir, `${stem}.vtt`), formatVtt(cues, ir.sampleRate));
        await writeFile(join(outDir, `${stem}.txt`), formatTxt(ir, cues));
      } catch (transcriptErr) {
        printError(
          `soundstage: warning: could not generate transcript files: ${transcriptErr instanceof Error ? transcriptErr.message : String(transcriptErr)}`,
        );
      }
    }
  } finally {
    if (tmpDir !== undefined) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  // 9. (Optional) Generate waveform.png + <stem>-player.html when --player is set.
  let playerOutputs = "";
  if (opts.player) {
    let waveformPath: string;
    try {
      waveformPath = await generateWaveform(mp3Path, outDir);
    } catch (err) {
      handleError(err);
    }
    try {
      await generatePlayer(ir, mp3Path, waveformPath, outDir);
    } catch (err) {
      handleError(err);
    }
    playerOutputs = `, ${stem}-player.html, waveform.png`;
  }

  // 10. Print cache report.
  const report = buildCacheReport(ir, chunkStats);
  process.stdout.write("soundstage: cache report\n");
  process.stdout.write(formatCacheReport(report) + "\n");

  // 11. Success message (include transcript filenames when --transcript is set).
  const transcriptOutputs = opts.transcript ? `, ${stem}.srt, ${stem}.vtt, ${stem}.txt` : "";
  process.stdout.write(
    `soundstage: render complete → ${stem}.wav, ${stem}.mp3${playerOutputs}${transcriptOutputs}\n`,
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
  .option("--final", "Use a real TTS adapter (default provider: kokoro)")
  .option(
    "--provider <name>",
    "TTS provider for --final renders: kokoro (default), openai, elevenlabs",
  )
  .option("--player", "Generate waveform.png + interactive HTML player alongside episode files")
  .option("--force", "Re-render even when IR is unchanged (bypass hash check)")
  .option("--transcript", "Generate .srt, .vtt, and .txt subtitle/transcript files")
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

// ---------------------------------------------------------------------------
// Feed command
// ---------------------------------------------------------------------------

interface FeedOptions {
  config: string;
  out?: string;
}

program
  .command("feed")
  .description("Generate a podcast RSS feed (feed.xml) from soundstage-feed.json")
  .option("--config <path>", "Path to soundstage-feed.json", "soundstage-feed.json")
  .option("--out <dir>", "Output directory (default: directory of config file)")
  .action(async (opts: FeedOptions) => {
    const configPath = resolve(opts.config);
    const configDir = dirname(configPath);
    const outDir = opts.out !== undefined ? resolve(opts.out) : configDir;

    // 1. Read and parse config file.
    let rawConfig: unknown;
    try {
      const text = await readFile(configPath, "utf8");
      rawConfig = JSON.parse(text) as unknown;
    } catch (err) {
      printError(
        `soundstage feed: config file not found or unreadable: ${configPath}` +
          (err instanceof Error ? ` (${err.message})` : ""),
      );
      process.exit(EXIT_USER_ERROR);
    }

    // 2. Validate config.
    let config;
    try {
      config = validateFeedConfig(rawConfig);
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(EXIT_USER_ERROR);
    }

    // 3. Build episode metadata (stat + ffprobe each mp3).
    const episodeMetas = [];
    for (const ep of config.episodes) {
      const mp3Path = resolve(configDir, ep.file);

      let byteSize: number;
      try {
        const s = await stat(mp3Path);
        byteSize = Number(s.size);
      } catch {
        printError(`soundstage feed: mp3 file not found: ${mp3Path}`);
        process.exit(EXIT_USER_ERROR);
      }

      let durationSeconds: number;
      try {
        const { durationSamples, sampleRate } = await probeFileDuration(mp3Path);
        durationSeconds = Math.round(durationSamples / sampleRate);
      } catch (err) {
        printError(
          `soundstage feed: ffprobe failed for ${mp3Path}: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(EXIT_FFMPEG_ERROR);
      }

      const url = config.show.baseUrl + basename(mp3Path);
      const meta: EpisodeMeta = {
        guid: ep.guid,
        title: ep.title,
        pubDate: ep.pubDate,
        url,
        byteSize,
        durationSeconds,
      };
      if (ep.description !== undefined) meta.description = ep.description;
      if (ep.explicit !== undefined) meta.explicit = ep.explicit;
      episodeMetas.push(meta);
    }

    // 4–6. Build XML + write to disk.
    try {
      const xml = buildFeedXml(config, episodeMetas);
      await mkdir(outDir, { recursive: true });
      const feedPath = join(outDir, "feed.xml");
      await writeFile(feedPath, xml, "utf8");
      process.stdout.write("soundstage: feed → feed.xml\n");
    } catch (err) {
      handleError(err);
    }
  });

// Only parse when this module is the CLI entry point (not when imported in tests or as a library).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  program.parse(process.argv);
}
