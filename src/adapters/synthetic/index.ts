// §4.4 — Synthetic TTS adapter for hermetic CI and golden fixtures.
// Generates a deterministic sine-wave tone whose frequency and duration are
// derived from a SHA-256 hash of (normalized text + voice + speed), so:
//   - same input  → byte-identical Float32Array
//   - different input → different but stable audio
// No network calls, no filesystem writes, no model downloads.

import { createHash } from "node:crypto";
import type { TtsAdapter, SynthRequest, SynthResult } from "../types.js";

const SAMPLE_RATE = 24000; // native rate; matches Kokoro so downstream code treats them alike
const MODEL_ID = "synthetic-v1";
// Default speed: 1.0 (neutral). Always emitted in canonicalSettings so that
// `speed: undefined` and `speed: 1.0` produce the same cache key.
// Exported so T11 (Kokoro adapter) can import rather than re-declare.
export const DEFAULT_SPEED = 1.0;

// Min/max duration in samples at SAMPLE_RATE (0.2s – 2.0s)
const MIN_SAMPLES = Math.round(0.2 * SAMPLE_RATE);
const MAX_SAMPLES = Math.round(2.0 * SAMPLE_RATE);

// Frequency range: 200 Hz – 2000 Hz
const MIN_FREQ = 200;
const MAX_FREQ = 2000;

/** Derive a stable hash key from the audio-affecting fields. */
function hashKey(text: string, voice: string, speed: number): Buffer {
  const h = createHash("sha256");
  h.update(text);
  // Null-byte separator guards against cross-field ambiguity: without it,
  // text="ab" voice="cd" and text="a" voice="bcd" would hash identically.
  h.update("\x00");
  h.update(voice.toLowerCase());
  h.update("\x00");
  h.update(String(speed));
  return h.digest();
}

/** Read a uint32 (big-endian) from a Buffer at the given byte offset. */
function readUint32BE(buf: Buffer, offset: number): number {
  return (
    (buf[offset]! << 24) |
    (buf[offset + 1]! << 16) |
    (buf[offset + 2]! << 8) |
    buf[offset + 3]!
  ) >>> 0; // coerce to unsigned
}

export class SyntheticAdapter implements TtsAdapter {
  readonly id = "synthetic";
  readonly model = MODEL_ID;

  canonicalSettings(req: SynthRequest): Record<string, unknown> {
    // Always emit speed resolved to its default so undefined and 1.0 produce the same key.
    return { voice: req.voice, speed: req.speed ?? DEFAULT_SPEED };
  }

  synth(req: SynthRequest): Promise<SynthResult> {
    const hash = hashKey(req.text, req.voice, req.speed ?? DEFAULT_SPEED);

    // Derive frequency from first 4 bytes
    const freqRaw = readUint32BE(hash, 0);
    const freq = MIN_FREQ + (freqRaw % (MAX_FREQ - MIN_FREQ + 1));

    // Derive duration from next 4 bytes
    const durRaw = readUint32BE(hash, 4);
    const durationSamples = MIN_SAMPLES + (durRaw % (MAX_SAMPLES - MIN_SAMPLES + 1));

    // Derive amplitude from next 2 bytes (0.1 – 0.9)
    const ampRaw = ((hash[8]! << 8) | hash[9]!) / 0xffff;
    const amplitude = 0.1 + ampRaw * 0.8;

    // Generate sine wave
    const pcm = new Float32Array(durationSamples);
    const twoPiFreq = (2 * Math.PI * freq) / SAMPLE_RATE;
    for (let i = 0; i < durationSamples; i++) {
      pcm[i] = amplitude * Math.sin(twoPiFreq * i);
    }

    return Promise.resolve({ pcm, sampleRate: SAMPLE_RATE, durationSamples });
  }
}
