// Golden tests for Task 3: Stereo Audio End-to-End.
// Tests run real ffmpeg via run.ts with synthetic-adapter WAV fixtures.
// Assertions via ffprobe/astats — never by ear.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileIR } from "../../src/compiler/index.js";
import { runFfmpeg } from "../../src/compiler/run.js";
import { CacheLayer } from "../../src/adapters/cache/index.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import type { IR, ClipIR } from "../../src/ir/phase-b.js";

const execFileAsync = promisify(execFile);
const SR = 48000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the channel count reported by ffprobe for the given file. */
async function probeChannels(path: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=channels",
    "-of", "json",
    path,
  ], { encoding: "utf8" }) as { stdout: string };

  const parsed = JSON.parse(stdout) as { streams: Array<{ channels?: number }> };
  const s = parsed.streams[0];
  if (!s || s.channels === undefined) throw new Error(`ffprobe: no channels in ${path}`);
  return s.channels;
}

/**
 * Measure RMS dBFS for a specific channel (0=left, 1=right) over the whole file.
 * Uses ffmpeg pan to isolate the channel then astats.
 */
async function probeChannelRmsDb(path: string, channelIndex: number): Promise<number> {
  // Pan to mono: left=c0, right=c1
  const panExpr = channelIndex === 0 ? "c0=c0" : "c0=c1";
  const { stderr } = await execFileAsync("ffmpeg", [
    "-y",
    "-i", path,
    "-af", `pan=mono|${panExpr},astats=metadata=1:reset=1`,
    "-f", "null",
    "-",
  ], { encoding: "utf8" }) as { stderr: string };

  const match = stderr.match(/RMS level dB:\s*(-inf|inf|[-\d.]+)/);
  if (!match) throw new Error(`probeChannelRmsDb: no RMS level dB in output for channel ${channelIndex} of ${path}`);
  const val = match[1]!;
  if (val === "-inf") return -Infinity;
  if (val === "inf") return Infinity;
  return parseFloat(val);
}

/** Measure broadband RMS dBFS over the whole file. */
async function probeRmsDb(path: string): Promise<number> {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-y",
    "-i", path,
    "-af", "astats=metadata=1:reset=1",
    "-f", "null",
    "-",
  ], { encoding: "utf8" }) as { stderr: string };

  const match = stderr.match(/RMS level dB:\s*(-inf|inf|[-\d.]+)/);
  if (!match) throw new Error(`probeRmsDb: no RMS level dB in output for ${path}`);
  const val = match[1]!;
  if (val === "-inf") return -Infinity;
  return parseFloat(val);
}

/**
 * Measure per-channel RMS dBFS over a time window in the output file.
 * atrim isolates the window; pan=mono extracts the requested channel.
 */
async function probeChannelRmsDbWindow(
  path: string,
  channelIndex: number,
  startSec: number,
  durationSec: number,
): Promise<number> {
  const panExpr = channelIndex === 0 ? "c0=c0" : "c0=c1";
  const { stderr } = await execFileAsync("ffmpeg", [
    "-y",
    "-i", path,
    "-af", [
      `atrim=start=${startSec}:duration=${durationSec}`,
      "asetpts=PTS-STARTPTS",
      `pan=mono|${panExpr}`,
      "astats=metadata=1:reset=1",
    ].join(","),
    "-f", "null", "-",
  ], { encoding: "utf8" }) as { stderr: string };

  const match = stderr.match(/RMS level dB:\s*(-inf|inf|[-\d.]+)/);
  if (!match) {
    throw new Error(
      `probeChannelRmsDbWindow: no RMS level dB for ch${channelIndex} ` +
      `window ${startSec}–${startSec + durationSec}s of ${path}`,
    );
  }
  const val = match[1]!;
  if (val === "-inf") return -Infinity;
  if (val === "inf") return Infinity;
  return parseFloat(val);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let cacheDir: string;
let wavVoice: string;    // voice WAV (24kHz f32le from synthetic adapter)
let durVoice: number;    // duration at 48kHz after upsampling

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-stereo-golden-"));
  cacheDir = join(tmpDir, "cache");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cacheDir, { recursive: true });

  const adapter = new SyntheticAdapter();
  const cache = new CacheLayer(adapter, cacheDir);

  const res = await cache.get({ text: "stereo golden test voice", voice: "host", sampleRate: 24000 });
  wavVoice = res.wavPath;
  durVoice = res.durationSamples * 2; // 24k → 48k
}, 60_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: build and run a stereo IR
// ---------------------------------------------------------------------------

function buildStereoVoiceIR(clips: ClipIR[]): IR {
  return {
    schemaVersion: 3,
    sampleRate: SR,
    channels: 2,
    episode: { title: "Stereo Golden" },
    tracks: [{ trackId: "voice" }],
    clips,
    ducking: [],
    chapters: [],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav"] },
  };
}

// ---------------------------------------------------------------------------
// Golden test 1: stereo output has channels=2
// ---------------------------------------------------------------------------

describe("stereo output: channels=2 via ffprobe", () => {
  it("stereo render produces a WAV with 2 channels", async () => {
    const outPath = join(tmpDir, "stereo-voice.wav");
    const ir = buildStereoVoiceIR([
      {
        id: "c0",
        sourceRef: { kind: "cache", path: wavVoice, hash: "vh", voiceUnitId: 0 },
        trackId: "voice",
        startSample: 0,
        durationSamples: durVoice,
        gainDb: 0,
        pan: 0.0,
      },
    ]);
    const compiled = compileIR(ir, outPath);
    await runFfmpeg(compiled);

    const channels = await probeChannels(outPath);
    expect(channels).toBe(2);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Golden test 2: voice panned full-left — left RMS ≥ 6 dB above right RMS
// ---------------------------------------------------------------------------

describe("stereo pan: full-left voice has dominant left channel", () => {
  it("voice panned -1.0 has left-channel RMS at least 6 dB above right-channel RMS", async () => {
    const outPath = join(tmpDir, "stereo-panned-left.wav");
    const ir = buildStereoVoiceIR([
      {
        id: "c0",
        sourceRef: { kind: "cache", path: wavVoice, hash: "vh", voiceUnitId: 0 },
        trackId: "voice",
        startSample: 0,
        durationSamples: durVoice,
        gainDb: 0,
        pan: -1.0,
      },
    ]);
    const compiled = compileIR(ir, outPath);
    await runFfmpeg(compiled);

    const leftRms = await probeChannelRmsDb(outPath, 0);
    const rightRms = await probeChannelRmsDb(outPath, 1);

    // Left should be very loud; right should be silent (-inf) or at least 6 dB below left.
    // Full-left pan → R coefficient = 0 → right channel is pure silence.
    // In practice right may be -Infinity; use a loose lower bound.
    if (rightRms === -Infinity) {
      // Right is silence — left dominates; test passes
      expect(Number.isFinite(leftRms)).toBe(true);
    } else {
      expect(leftRms - rightRms).toBeGreaterThanOrEqual(6);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Golden test 3: stereo + bed — channels=2, bed is audible (smoke test)
// ---------------------------------------------------------------------------

describe("stereo + bed golden test (C1 fix)", () => {
  it("stereo IR with voice and bed renders without error; ffprobe confirms channels=2; bed is audible", async () => {
    const outPath = join(tmpDir, "stereo-bed.wav");

    // Build a short sine bed WAV via ffmpeg for the test
    const bedPath = join(tmpDir, "bed.wav");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", `sine=frequency=440:sample_rate=24000:duration=2`,
      "-c:a", "pcm_f32le",
      "--",
      bedPath,
    ], { encoding: "utf8" });

    const ir: IR = {
      schemaVersion: 3,
      sampleRate: SR,
      channels: 2,
      episode: { title: "Stereo+Bed Test" },
      tracks: [{ trackId: "voice" }, { trackId: "bed-0" }],
      clips: [
        {
          id: "c0",
          sourceRef: { kind: "cache", path: wavVoice, hash: "vh", voiceUnitId: 0 },
          trackId: "voice",
          startSample: 0,
          durationSamples: durVoice,
          gainDb: 0,
          pan: 0.0,
        },
        {
          id: "c1",
          sourceRef: { kind: "file", path: bedPath },
          trackId: "bed-0",
          startSample: 0,
          durationSamples: durVoice,
          gainDb: 0,
          pan: 0.0,
          loop: true,
        },
      ],
      ducking: [
        { bedTrackId: "bed-0", duckUnderTrackId: "voice", reductionDb: -12, preset: "speech-v1" },
      ],
      chapters: [],
      loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
      render: { outputs: ["wav"] },
    };

    const compiled = compileIR(ir, outPath);
    await runFfmpeg(compiled);

    // Must be stereo
    const channels = await probeChannels(outPath);
    expect(channels).toBe(2);

    // Bed must be audible: overall RMS must be finite (non-silent)
    const rms = await probeRmsDb(outPath);
    expect(Number.isFinite(rms)).toBe(true);
    expect(rms).toBeGreaterThan(-60); // not silence
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Golden test 4: per-channel ducking is pan-independent (Fix 1 correctness)
//
// Voice is panned hard-left. Without Fix 1, sidechaincompress operated
// per-channel: the right-channel key was ~0, so the right bed channel was not
// ducked. Fix 1 mono-sums the key so both channels carry the full voice
// signal — the right bed channel is now ducked equally with the left.
//
// We cannot cleanly measure the left-channel ducking when the voice
// also contributes to the left channel. The right channel is the clean probe:
//   • during voice span: right output = ducked-bed-right (voice contributes 0)
//   • during gap:        right output = unduckeded-bed-right
// A ≥ 6 dB gap→voice difference proves per-channel ducking works.
// Since the mono-sum key is identical on L/R, the same reduction applies to
// the left bed channel, so the right-channel assertion covers both channels.
// ---------------------------------------------------------------------------

describe("stereo + bed: per-channel ducking is pan-independent (Fix 1)", () => {
  const VOICE_SECS = 1.5;
  const TOTAL_SECS = 3.0;
  const VOICE_SAMPLES = Math.round(VOICE_SECS * SR);
  const TOTAL_SAMPLES = Math.round(TOTAL_SECS * SR);

  let voiceFixturePath: string;
  let bedFixturePath: string;
  let ducOutPath: string;

  beforeAll(async () => {
    voiceFixturePath = join(tmpDir, "voice-duc-fixture.wav");
    bedFixturePath = join(tmpDir, "bed-duc-fixture.wav");
    ducOutPath = join(tmpDir, "stereo-bed-panned-duc.wav");

    // 1.5s mono 440 Hz sine at 24 kHz (compiler will resample to 48 kHz)
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi",
      "-i", `sine=frequency=440:sample_rate=24000:duration=${VOICE_SECS}`,
      "-c:a", "pcm_f32le", "--", voiceFixturePath,
    ], { encoding: "utf8" });

    // 4s mono 220 Hz sine at 24 kHz — longer than the voice so the bed
    // continues into the gap window (trimmed to TOTAL_SECS by the IR)
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi",
      "-i", `sine=frequency=220:sample_rate=24000:duration=4`,
      "-c:a", "pcm_f32le", "--", bedFixturePath,
    ], { encoding: "utf8" });
  }, 60_000);

  it("right-channel bed is ducked ≥ 6 dB during left-panned voice vs post-voice gap", async () => {
    const ir: IR = {
      schemaVersion: 3,
      sampleRate: SR,
      channels: 2,
      episode: { title: "Per-channel ducking test" },
      tracks: [{ trackId: "voice" }, { trackId: "bed-0" }],
      clips: [
        // Voice clip: panned hard-left, boosted +12 dB so the sidechain key is
        // well above the compressor threshold (0.05 linear ≈ -26 dBFS).
        // lavfi sine is ~-18 dBFS; +12 dB → -6 dBFS peak; after mono-sum
        // of the stereo key: 0.5 × amplitude → -12 dBFS, 14 dB above threshold
        // → ~12 dB of gain reduction on both bed channels.
        {
          id: "cv0",
          sourceRef: { kind: "file", path: voiceFixturePath },
          trackId: "voice",
          startSample: 0,
          durationSamples: VOICE_SAMPLES,
          gainDb: 12,
          pan: -1.0,
        },
        // Silence clip: extends the voice LANE to TOTAL_SECS so the key signal
        // (from asplit) goes quiet after VOICE_SECS and the compressor has time
        // to release before we measure the gap window.
        {
          id: "cv1",
          sourceRef: { kind: "silence" },
          trackId: "voice",
          startSample: VOICE_SAMPLES,
          durationSamples: VOICE_SAMPLES,
          gainDb: 0,
        },
        // Bed: centered, covers the full TOTAL_SECS
        {
          id: "cb0",
          sourceRef: { kind: "file", path: bedFixturePath },
          trackId: "bed-0",
          startSample: 0,
          durationSamples: TOTAL_SAMPLES,
          gainDb: 0,
          pan: 0.0,
          loop: false,
        },
      ],
      ducking: [
        {
          bedTrackId: "bed-0",
          duckUnderTrackId: "voice",
          reductionDb: -12,
          preset: "speech-v1",
        },
      ],
      chapters: [],
      loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
      render: { outputs: ["wav"] },
    };

    const compiled = compileIR(ir, ducOutPath);
    await runFfmpeg(compiled);

    // Right channel during voice (0.3–0.9s): past attack ramp, compressor active
    const rightDuringVoice = await probeChannelRmsDbWindow(ducOutPath, 1, 0.3, 0.6);
    // Right channel in gap (2.0–2.5s): 500ms after voice ends, compressor released
    const rightDuringGap = await probeChannelRmsDbWindow(ducOutPath, 1, 2.0, 0.5);

    // Both must be finite (bed is present in both windows)
    expect(Number.isFinite(rightDuringVoice)).toBe(true);
    expect(Number.isFinite(rightDuringGap)).toBe(true);

    // Gap must be ≥ 6 dB louder than during voice — proves right-channel ducking
    expect(rightDuringGap - rightDuringVoice).toBeGreaterThanOrEqual(6);
  }, 30_000);
});
