// Audiogram generator — §6 --video flag.
// Produces <stem>-audiogram.mp4: animated waveform + episode title over a solid
// background, optionally with chapter tick marks and a logo overlay, muxed with
// the episode audio. Fixed template, minimal config only (aspect, accent color,
// logo PNG). No layout/scene/timeline/animation DSL.
//
// Pattern: temp filter-script file + execFile (matches runFfmpeg in run.ts).
// Note: generateWaveform in player.ts uses inline -lavfi — NOT the reference pattern.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { IR } from "../ir/phase-b.js";

const execFileAsync = promisify(execFile);

// Absolute path to the vendored DejaVuSans.ttf — required by every drawtext filter.
// Resolved at module load time relative to this file so it works as both source and dist.
const FONT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../assets/fonts/DejaVuSans.ttf",
);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AspectPreset = "square" | "landscape" | "vertical";

export interface AudiogramOptions {
  /** Aspect ratio preset. Default: 'square' (1080×1080). */
  aspect?: AspectPreset | undefined;
  /** Waveform accent color (hex). Default: '#2563eb'. */
  accentColor?: string | undefined;
  /** Absolute path to a PNG logo file to overlay in the top-right corner. */
  logoPath?: string | undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface Dims {
  W: number;
  H: number;
}

function dimensionsForAspect(aspect: AspectPreset | undefined): Dims {
  switch (aspect) {
    case "landscape": return { W: 1920, H: 1080 };
    case "vertical":  return { W: 1080, H: 1920 };
    default:          return { W: 1080, H: 1080 }; // square (default)
  }
}

/**
 * Escape a string for use as the `text` value in a drawtext filter written to
 * a filter-complex script file (NOT a shell string). Rules for the FILE context:
 *   - backslashes → doubled (\\)
 *   - single quotes → '\'' (end-quote, backslash-quote, start-quote)
 *   - colons → \:
 *   - percent → %% (prevents drawtext expansion of %{pts}, %{localtime:…}, etc.)
 */
function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")   // backslashes first (must be before other replacements)
    .replace(/'/g, "'\\''")   // single quote: close-quote escape start-quote
    .replace(/:/g, "\\:")     // colon
    .replace(/%/g, "%%");     // percent: prevent drawtext variable expansion
}

/**
 * Escape a filesystem path for use as a filter-option value in a filter-complex
 * script file (e.g. fontfile=, movie=). The value is wrapped in single quotes;
 * any single quotes within the path are escaped as '\''.
 */
function escapeFilterPath(p: string): string {
  // Escape backslashes first (C:\ etc.), then escape any single quotes.
  const escaped = p.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

// ---------------------------------------------------------------------------
// buildAudiogramFilter — pure, unit-testable, no I/O
// ---------------------------------------------------------------------------

/**
 * Build the filter-complex script string for an audiogram.
 *
 * Pure function — no filesystem access, no ffmpeg invocation. Suitable for
 * unit testing without ffmpeg available.
 *
 * Layout (all presets use the same proportions):
 *   - Waveform: center 40% of height, 92% of frame width
 *   - Title: top 10% of height, horizontally centered
 *   - Chapter ticks: bottom 5% of height (omitted when 0 chapters)
 *   - Logo: top-right corner, 16px margin (omitted when logoPath is undefined)
 *
 * @param ir           Episode IR (title, chapters, clips for total samples).
 * @param _mp3Filename Basename of the mp3 (unused in the filter graph; kept for API symmetry).
 * @param opts         Audiogram options (aspect, accentColor, logoPath).
 * @param fontPath     Absolute path to DejaVuSans.ttf (defaults to vendored font).
 */
export function buildAudiogramFilter(
  ir: IR,
  _mp3Filename: string,
  opts: AudiogramOptions,
  fontPath = FONT_PATH,
): string {
  const { W, H } = dimensionsForAspect(opts.aspect);
  const accentColor = opts.accentColor ?? "#2563eb";

  // Validate accentColor: only hex colors are safe here — the value is interpolated
  // into `colors=${accentColor}` inside showwaves, where `:` injects ffmpeg options
  // and `;` injects new filter chains.
  if (!/^#?[0-9a-fA-F]{6}$/.test(accentColor)) {
    throw new Error(
      `audiogram: invalid accentColor "${accentColor}" — must be a 6-digit hex color (e.g. #2563eb)`,
    );
  }

  // Waveform: center 40% of height, 92% of frame width
  const waveW = Math.round(W * 0.92);
  const waveH = Math.round(H * 0.40);
  const waveX = Math.round((W - waveW) / 2);
  const waveY = Math.round((H - waveH) / 2);

  // Title: top 10% of height; y at ~5% from top for visual comfort
  const titleY = Math.round(H * 0.05);
  const fontSize = Math.round(W * 0.04);

  // Chapter ticks: bottom 5% of height
  const tickY = Math.round(H * 0.95);
  const tickH = Math.round(H * 0.05);

  // Total episode samples for tick X-position scaling
  const totalSamples = ir.clips.reduce(
    (max, c) => Math.max(max, c.startSample + c.durationSamples),
    1, // default to 1 to avoid division by zero on empty episode
  );

  const lines: string[] = [];

  // 1. Background (infinite stream; -shortest trims to audio length)
  lines.push(`color=c=#1a1a2e:s=${W}x${H}:r=30 [bg]`);

  // 2. Animated waveform from audio input [0:a]
  lines.push(
    `[0:a] showwaves=s=${waveW}x${waveH}:mode=line:r=30:colors=${accentColor}:scale=sqrt [wave]`,
  );

  // 3. Overlay waveform onto background, centered
  lines.push(`[bg][wave] overlay=${waveX}:${waveY}:shortest=1 [composed]`);

  // 4. Episode title via drawtext (fontfile required — C1: eliminates fontconfig dependency)
  const escapedTitle = escapeDrawtext(ir.episode.title);
  const quotedFont = escapeFilterPath(fontPath);
  lines.push(
    `[composed] drawtext=fontfile=${quotedFont}:text='${escapedTitle}':fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=#1a1a2e@0.6:boxborderw=12:x=(W-tw)/2:y=${titleY} [titled]`,
  );

  // 5. Chapter ticks (one drawbox per chapter; omitted when 0 chapters)
  if (ir.chapters.length === 0) {
    lines.push(`[titled] copy [out_v]`);
  } else {
    let prevLabel = "[titled]";
    ir.chapters.forEach((chapter, i) => {
      const tickX = Math.round((chapter.startSample / totalSamples) * W);
      const isLast = i === ir.chapters.length - 1;
      const nextLabel = isLast ? "[out_v]" : `[tick_${i}]`;
      lines.push(
        `${prevLabel} drawbox=x=${tickX}:y=${tickY}:w=2:h=${tickH}:color=white@0.7:t=fill ${nextLabel}`,
      );
      prevLabel = nextLabel;
    });
  }

  // 6. Logo overlay (omitted when logoPath is undefined)
  if (opts.logoPath !== undefined) {
    const quotedLogo = escapeFilterPath(opts.logoPath);
    lines.push(`movie=${quotedLogo}[logo]`);
    lines.push(`[out_v][logo] overlay=W-overlay_w-16:16 [out_v_final]`);
  }

  return lines.join(";\n");
}

// ---------------------------------------------------------------------------
// generateAudiogram — async, writes temp file, invokes ffmpeg
// ---------------------------------------------------------------------------

/**
 * Generate a social-video audiogram for an episode.
 *
 * Writes the filter-complex script to a temp file (same pattern as runFfmpeg
 * in run.ts) and invokes ffmpeg via execFile with libx264 + aac.
 *
 * @param ir      Episode IR.
 * @param mp3Path Absolute path to the final mp3 (post-loudnorm).
 * @param opts    Audiogram options.
 * @param outDir  Output directory.
 * @returns       Absolute path to the generated <stem>-audiogram.mp4.
 * @throws        Error starting with "audiogram generation failed:" on ffmpeg non-zero exit.
 */
export async function generateAudiogram(
  ir: IR,
  mp3Path: string,
  opts: AudiogramOptions,
  outDir: string,
): Promise<string> {
  const mp3Filename = basename(mp3Path);
  const stem = mp3Filename.replace(/\.mp3$/i, "");
  const mp4Path = join(outDir, `${stem}-audiogram.mp4`);

  const filterScript = buildAudiogramFilter(ir, mp3Filename, opts);

  // Write filter script to a named temp file (not argv string — same pattern as runFfmpeg).
  const scriptPath = join(
    tmpdir(),
    `soundstage-audiogram-${randomBytes(8).toString("hex")}.txt`,
  );
  await writeFile(scriptPath, filterScript, { encoding: "utf8", mode: 0o600, flag: "wx" });

  const hasLogo = opts.logoPath !== undefined;
  const mapVideo = hasLogo ? "[out_v_final]" : "[out_v]";

  const argv = [
    "-i", mp3Path,
    "-filter_complex_script", scriptPath,
    "-map", mapVideo,
    "-map", "0:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "23",
    "-c:a", "aac", "-b:a", "192k",
    "-r", "30",
    "-shortest",
    "-y",
    mp4Path,
  ];

  try {
    await execFileAsync("ffmpeg", argv, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
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
    throw new Error(`audiogram generation failed:\n${stderr.slice(-2000)}`);
  } finally {
    await rm(scriptPath, { force: true });
  }

  return mp4Path;
}
