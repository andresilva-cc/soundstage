// §4.4 — Kokoro TTS adapter. Lazy-loads kokoro-js on first synth() call.
// kokoro-js is an optional peer dependency — not imported at module top-level.
// Model: onnx-community/Kokoro-82M-v1.0-ONNX, dtype q8, 24kHz mono.

import type { TtsAdapter, SynthRequest, SynthResult } from "../types.js";
import type { KokoroTTS, GenerateOptions } from "kokoro-js";
import { DEFAULT_SPEED } from "../synthetic/index.js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const SAMPLE_RATE = 24000;

/** Cached KokoroTTS instance — loaded once per process on first synth(). */
let ttsInstance: KokoroTTS | null = null;

/** Load (or return cached) KokoroTTS instance. Throws a clear error if kokoro-js isn't installed. */
async function getOrLoadTts(): Promise<KokoroTTS> {
  if (ttsInstance !== null) {
    return ttsInstance;
  }

  let mod: { KokoroTTS: { from_pretrained(id: string, opts: { dtype: string }): Promise<KokoroTTS> } };
  try {
    mod = (await import("kokoro-js")) as typeof mod;
  } catch {
    throw new Error(
      "kokoro-js is not installed — it provides the default (real) voice.\n" +
      "  → Install it for real voices:    npm install kokoro-js\n" +
      "  → Or preview without a download: re-run with --draft  (synthetic voice)"
    );
  }

  try {
    ttsInstance = await mod.KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8" });
  } catch (err) {
    ttsInstance = null; // allow retry on next call
    throw err;
  }
  return ttsInstance;
}

export class KokoroAdapter implements TtsAdapter {
  readonly id = "kokoro";
  readonly model = "Kokoro-82M-v1.0-ONNX-q8";

  canonicalSettings(req: SynthRequest): Record<string, unknown> {
    // voice is a top-level cache key field (§4.5) — do NOT include here.
    // Always resolve speed to the default so undefined and 1.0 produce the same key.
    return { speed: req.speed ?? DEFAULT_SPEED };
  }

  async synth(req: SynthRequest): Promise<SynthResult> {
    const tts = await getOrLoadTts();
    const speed = req.speed ?? DEFAULT_SPEED;
    const audio = await tts.generate(req.text, { voice: req.voice as NonNullable<GenerateOptions["voice"]>, speed });
    if (audio.sampling_rate !== SAMPLE_RATE) {
      throw new Error(`kokoro-js returned unexpected sampling_rate ${audio.sampling_rate} (expected ${SAMPLE_RATE})`);
    }
    const pcm = audio.audio as Float32Array;
    return {
      pcm,
      sampleRate: audio.sampling_rate,
      durationSamples: pcm.length,
    };
  }
}
