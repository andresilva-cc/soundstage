// §4.4 — OpenAI TTS adapter.
// Uses the native Node 18+ fetch API (no SDK dep — single REST endpoint).
// Returns int16 PCM at 24000 Hz, 1 ch; converted to Float32 on receipt.
// API key read from process.env.OPENAI_API_KEY at synth() call time.

import type { TtsAdapter, SynthRequest, SynthResult } from "../types.js";
import { SoundstageError } from "../../ir/errors.js";
import { withRetry, HttpResponseError } from "../cloud/retry.js";

const OPENAI_TTS_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const SAMPLE_RATE = 24000; // OpenAI TTS PCM output rate

export class OpenAiAdapter implements TtsAdapter {
  readonly id = "openai";
  readonly model: string;

  constructor(opts?: { model?: string }) {
    this.model = opts?.model ?? "tts-1";
  }

  canonicalSettings(req: SynthRequest): Record<string, unknown> {
    // speed is the only audio-affecting setting; always resolve to default.
    // voice, sampleRate, and the API key MUST NOT appear here.
    return { speed: req.speed ?? 1.0 };
  }

  async synth(req: SynthRequest): Promise<SynthResult> {
    // Read API key at call time — never store in constructor.
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new SoundstageError(
        "E_ADAPTER_MISSING_KEY",
        "OPENAI_API_KEY is not set — export OPENAI_API_KEY=sk-... before rendering",
        "OpenAiAdapter.synth",
      );
    }

    let pcm: Float32Array;
    try {
      pcm = await withRetry(async () => {
        const response = await fetch(OPENAI_TTS_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            voice: req.voice,
            input: req.text,
            response_format: "pcm",
            speed: req.speed ?? 1.0,
          }),
        });

        if (!response.ok) {
          throw new HttpResponseError(
            response.status,
            `OpenAI TTS error: ${response.status} ${response.statusText}`,
          );
        }

        const buffer = await response.arrayBuffer();
        // Convert int16 PCM → Float32: divide each sample by 32768.0
        const int16View = new Int16Array(buffer);
        const float32 = new Float32Array(int16View.length);
        for (let i = 0; i < int16View.length; i++) {
          float32[i] = int16View[i]! / 32768.0;
        }
        return float32;
      });
    } catch (err) {
      // Terminal failure (all retries exhausted, or non-retriable network error).
      // Re-throw as a structured adapter error so handleError routes to exit 2.
      let detail: string;
      if (err instanceof HttpResponseError) {
        detail = `HTTP ${err.status} ${err.message}`;
      } else if (err instanceof Error) {
        detail = err.message;
      } else {
        detail = String(err);
      }
      throw new SoundstageError(
        "E_ADAPTER_REQUEST_FAILED",
        `OpenAI TTS request failed: ${detail}`,
        "OpenAiAdapter.synth",
      );
    }

    return {
      pcm,
      sampleRate: SAMPLE_RATE,
      durationSamples: pcm.length,
    };
  }
}
