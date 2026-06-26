// §4.4 — ElevenLabs TTS adapter. Lazy-loads 'elevenlabs' on first synth() call.
// 'elevenlabs' is an optional peer dependency — not imported at module top-level.
// Voice prop value is the ElevenLabs voice UUID directly (no name→ID lookup).
// Output: pcm_24000 (int16 at 24kHz, 1 ch), converted to Float32 on receipt.
// API key read from process.env.ELEVENLABS_API_KEY at synth() call time — never stored.
// Internal chunking (~2400 chars) at sentence boundaries: N sequential calls, PCM concatenated.
// Cache key uses the full normalized text (transparent to the caller / cache layer).

import type { TtsAdapter, SynthRequest, SynthResult } from "../types.js";
import { SoundstageError } from "../../ir/errors.js";
import { withRetry, HttpResponseError } from "../cloud/retry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ElevenLabs practical per-request character limit. */
const CHAR_LIMIT = 2400;

/** PCM output sample rate (int16, 1 ch). */
const SAMPLE_RATE = 24000;

// ---------------------------------------------------------------------------
// Minimal structural interfaces for the lazy-loaded module
// (avoids top-level import from 'elevenlabs'; types are erased at emit)
// ---------------------------------------------------------------------------

interface ElevenLabsVoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
}

interface ElevenLabsTtsRequest {
  text: string;
  model_id?: string;
  output_format?: string;
  voice_settings?: ElevenLabsVoiceSettings;
}

interface ElevenLabsRequestOptions {
  maxRetries?: number;
}

interface ElevenLabsClientShape {
  textToSpeech: {
    convert(
      voiceId: string,
      request: ElevenLabsTtsRequest,
      options?: ElevenLabsRequestOptions,
    ): Promise<AsyncIterable<Buffer>>;
  };
}

interface ElevenLabsModule {
  ElevenLabsClient: new (opts: { apiKey: string }) => ElevenLabsClientShape;
}

// ---------------------------------------------------------------------------
// Lazy module cache (populated on first synth() call)
// ---------------------------------------------------------------------------

let cachedMod: ElevenLabsModule | null = null;

async function getModule(): Promise<ElevenLabsModule> {
  if (cachedMod !== null) return cachedMod;
  try {
    cachedMod = (await import("elevenlabs")) as unknown as ElevenLabsModule;
  } catch {
    throw new Error(
      "elevenlabs is not installed — it is required for the ElevenLabs TTS provider.\n" +
        "  → Install it:               npm install elevenlabs\n" +
        "  → Or use a different voice: re-run with --provider kokoro|openai",
    );
  }
  return cachedMod;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split text into chunks of at most CHAR_LIMIT chars, splitting at sentence
 * boundaries (./?/! followed by whitespace). Single sentences that exceed the
 * limit are passed as-is (ElevenLabs may truncate or error — logged as a warning).
 * Returns [text] unchanged when text.length <= CHAR_LIMIT.
 */
function splitIntoChunks(text: string): string[] {
  if (text.length <= CHAR_LIMIT) return [text];

  // Split on whitespace that follows sentence-ending punctuation (./?/!).
  // This keeps punctuation attached to its sentence.
  const candidates = text.split(/(?<=[.!?])\s+/);

  const chunks: string[] = [];
  let current = "";

  for (const part of candidates) {
    const sep = current ? " " : "";
    if (current.length + sep.length + part.length <= CHAR_LIMIT) {
      current += sep + part;
    } else {
      if (current) chunks.push(current);
      // Oversized single sentence: pass through as-is.
      current = part;
    }
  }

  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

/** Collect an async-iterable stream into a single Buffer. */
async function collectStream(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** Convert a Buffer of int16 LE samples to a Float32Array (/ 32768.0). */
function int16ToFloat32(buf: Buffer): Float32Array {
  // Buffer may not be aligned — copy into a properly-aligned ArrayBuffer.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const int16View = new Int16Array(ab);
  const float32 = new Float32Array(int16View.length);
  for (let i = 0; i < int16View.length; i++) {
    float32[i] = int16View[i]! / 32768.0;
  }
  return float32;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ElevenLabsAdapter implements TtsAdapter {
  readonly id = "elevenlabs";
  readonly model: string;

  constructor(opts: { model: string }) {
    this.model = opts.model;
  }

  /**
   * Returns all four audio-affecting ElevenLabs settings resolved to their defaults.
   * voice, sampleRate, and ELEVENLABS_API_KEY must NOT appear here.
   * Extra fields on req (stability, similarity_boost, style, use_speaker_boost) are
   * accepted at runtime to allow callers to override per-request; SynthRequest does not
   * declare them, so they are accessed via a cast.
   */
  canonicalSettings(req: SynthRequest): Record<string, unknown> {
    const r = req as SynthRequest & {
      stability?: number;
      similarity_boost?: number;
      style?: number;
      use_speaker_boost?: boolean;
    };
    return {
      stability: r.stability ?? 0.5,
      similarity_boost: r.similarity_boost ?? 0.75,
      style: r.style ?? 0.0,
      use_speaker_boost: r.use_speaker_boost ?? true,
    };
  }

  async synth(req: SynthRequest): Promise<SynthResult> {
    // Read API key at call time — never store in constructor or field.
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new SoundstageError(
        "E_ADAPTER_MISSING_KEY",
        "ELEVENLABS_API_KEY is not set — export ELEVENLABS_API_KEY=<key> before rendering",
        "ElevenLabsAdapter.synth",
      );
    }

    const elevenLabs = await getModule();
    const client = new elevenLabs.ElevenLabsClient({ apiKey });

    const settings = this.canonicalSettings(req);
    const chunks = splitIntoChunks(req.text);

    const pcmParts: Float32Array[] = [];

    for (const chunk of chunks) {
      let chunkBuf: Buffer;
      try {
        chunkBuf = await withRetry(async () => {
          try {
            // Both convert() and collectStream() are inside this catch so that mid-stream
            // SDK errors (thrown during async iteration) are also classified and retried.
            const stream = await client.textToSpeech.convert(
              req.voice,
              {
                text: chunk,
                model_id: this.model,
                output_format: "pcm_24000",
                voice_settings: {
                  stability: settings.stability as number,
                  similarity_boost: settings.similarity_boost as number,
                  style: settings.style as number,
                  use_speaker_boost: settings.use_speaker_boost as boolean,
                },
              },
              { maxRetries: 0 }, // disable SDK retry; withRetry handles it
            );
            return await collectStream(stream);
          } catch (err) {
            // Convert ElevenLabs SDK errors (duck-typed by .statusCode) → HttpResponseError
            // so withRetry can classify retriable vs non-retriable.
            if (
              typeof err === "object" &&
              err !== null &&
              typeof (err as Record<string, unknown>).statusCode === "number"
            ) {
              const e = err as { statusCode: number; message?: string };
              throw new HttpResponseError(
                e.statusCode,
                e.message ?? `ElevenLabs HTTP ${e.statusCode}`,
              );
            }
            throw err;
          }
        });
      } catch (err) {
        // Terminal failure — all retries exhausted or non-retriable error.
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
          `ElevenLabs TTS request failed: ${detail}`,
          "ElevenLabsAdapter.synth",
        );
      }

      pcmParts.push(int16ToFloat32(chunkBuf));
    }

    // Concatenate PCM from all chunks into a single Float32Array.
    const totalLength = pcmParts.reduce((sum, p) => sum + p.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const part of pcmParts) {
      combined.set(part, offset);
      offset += part.length;
    }

    return {
      pcm: combined,
      sampleRate: SAMPLE_RATE,
      durationSamples: combined.length,
    };
  }
}
