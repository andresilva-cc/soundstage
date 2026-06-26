// Waveform image + interactive HTML player generator — §6 --player flag.
// Produces two artifacts next to episode.wav/mp3:
//   waveform.png         — ffmpeg showwavespic render of the final mp3
//   <stem>-player.html  — self-contained HTML player with chapter markers
//
// All CSS and JS are inlined; no <script src> or <link href> to external URLs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { IR } from "../ir/phase-b.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Waveform
// ---------------------------------------------------------------------------

/**
 * Generate waveform.png from the final mp3 via ffmpeg showwavespic.
 * Returns the path to the generated PNG.
 * Throws an Error starting with "waveform generation failed:" on ffmpeg error
 * (CLI handleError maps this to exit 3).
 */
export async function generateWaveform(mp3Path: string, outDir: string): Promise<string> {
  const pngPath = join(outDir, "waveform.png");
  const argv = [
    "-i", mp3Path,
    "-lavfi", "showwavespic=s=1200x120:colors=steelblue:filter=peak",
    "-frames:v", "1",
    "-y",
    "--",
    pngPath,
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
    throw new Error(`waveform generation failed:\n${stderr.slice(-2000)}`);
  }

  return pngPath;
}

// ---------------------------------------------------------------------------
// HTML player
// ---------------------------------------------------------------------------

/** Escape HTML entities for safe injection into attribute values and text. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the self-contained HTML player string.
 *
 * @param ir             The episode IR (chapters, title, author, sampleRate).
 * @param mp3Filename    Basename of the mp3 file (relative — not a full path).
 * @param waveformBase64 Base64-encoded PNG bytes of the waveform image.
 * @returns              Complete HTML document as a string.
 */
export function buildPlayerHtml(ir: IR, mp3Filename: string, waveformBase64: string): string {
  const title = ir.episode.title;
  const author = ir.episode.author;
  const heading = author !== undefined ? `${title} — ${author}` : title;

  // Chapter buttons: one per entry; onclick contains startSample/sampleRate as a literal number.
  const chapterButtons = ir.chapters
    .map((chapter, i) => {
      const time = chapter.startSample / ir.sampleRate;
      return `    <button data-chapter="${i}" onclick="document.getElementById('player').currentTime=${time}">${escapeHtml(chapter.title)}</button>`;
    })
    .join("\n");

  // Chapters as a JS literal array for the timeupdate handler.
  const chaptersJs = ir.chapters
    .map((chapter, i) => {
      const start = chapter.startSample / ir.sampleRate;
      const end = chapter.endSample / ir.sampleRate;
      return `      { idx: ${i}, start: ${start}, end: ${end} }`;
    })
    .join(",\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(heading)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; background: #0f0f0f; color: #e8e8e8; }
    h1 { font-size: 1.4rem; margin-bottom: 1rem; }
    audio { width: 100%; margin-bottom: 1rem; }
    .waveform { width: 100%; margin-bottom: 1.5rem; border-radius: 4px; display: block; }
    .chapters { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    button { background: #1e1e1e; border: 1px solid #333; color: #e8e8e8; padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    button:hover { background: #2a2a2a; }
    button[aria-current="true"] { background: #2563eb; border-color: #2563eb; }
  </style>
</head>
<body>
  <h1>${escapeHtml(heading)}</h1>
  <audio id="player" src="${encodeURIComponent(mp3Filename)}" controls></audio>
  <img class="waveform" src="data:image/png;base64,${waveformBase64}" alt="Waveform">
  <div class="chapters">
${chapterButtons}
  </div>
  <script>
    var chapters = [
${chaptersJs}
    ];
    var player = document.getElementById('player');
    var buttons = document.querySelectorAll('.chapters button');
    player.addEventListener('timeupdate', function() {
      var t = player.currentTime;
      var cur = -1;
      for (var i = 0; i < chapters.length; i++) {
        if (t >= chapters[i].start) cur = i;
      }
      for (var j = 0; j < buttons.length; j++) {
        buttons[j].setAttribute('aria-current', String(j === cur));
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Generate the HTML player file.
 * Reads the waveform PNG, builds the HTML, writes it to <outDir>/<stem>-player.html.
 * Returns the path to the generated HTML file.
 *
 * @param ir              The episode IR.
 * @param mp3Path         Full path to the final mp3 (used to derive the filename and stem).
 * @param waveformPngPath Full path to the waveform PNG.
 * @param outDir          Output directory.
 */
export async function generatePlayer(
  ir: IR,
  mp3Path: string,
  waveformPngPath: string,
  outDir: string,
): Promise<string> {
  const mp3Filename = basename(mp3Path);
  const stem = mp3Filename.replace(/\.mp3$/i, "");
  const htmlPath = join(outDir, `${stem}-player.html`);

  const waveformBuffer = await readFile(waveformPngPath);
  const waveformBase64 = waveformBuffer.toString("base64");

  const html = buildPlayerHtml(ir, mp3Filename, waveformBase64);
  await writeFile(htmlPath, html, { encoding: "utf8" });

  return htmlPath;
}
