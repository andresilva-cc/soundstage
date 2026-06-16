// §4.4 — TTS adapter interface (the extension seam)

export interface SynthRequest {
  text: string;       // normalized text (see §4.5)
  voice: string;      // effective voice id (post-inheritance)
  speed?: number;     // effective speed
  sampleRate: number; // requested PCM rate (adapter may return native; cache records actual)
}

export interface SynthResult {
  pcm: Float32Array;      // mono, f32le; 1 channel
  sampleRate: number;     // ACTUAL rate of pcm (e.g. 24000 for Kokoro)
  durationSamples: number; // = pcm.length (at sampleRate)
}

export interface TtsAdapter {
  /** Stable provider identity, part of the cache key. e.g. "kokoro", "synthetic", "openai". */
  readonly id: string;

  /** Model identifier, part of the cache key. e.g. "Kokoro-82M-v1.0-ONNX-q8". */
  readonly model: string;

  /**
   * Canonicalize provider-specific settings into a deterministic, stable object that
   * is JSON-serialized into the cache key. MUST be order-independent and float-stable
   * (see §4.5). Anything that changes the audio MUST appear here; anything that does
   * not (e.g. a request timeout) MUST NOT. Do NOT include voice, sampleRate, sampleFmt,
   * or channels — those are owned by the cache layer's separate top-level fields (§4.5).
   * Always resolve optional fields to their effective default before returning so that
   * `undefined` and the explicit default never produce different keys.
   */
  canonicalSettings(req: SynthRequest): Record<string, unknown>;

  /**
   * Synthesize. Returns PCM as raw samples plus the true sample count.
   * The adapter does NOT touch the cache or the filesystem — the cache layer wraps it.
   */
  synth(req: SynthRequest): Promise<SynthResult>;
}
