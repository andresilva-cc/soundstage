// Integration test for the real ElevenLabs TTS API.
// MANUAL / GATED: skipped when ELEVENLABS_API_KEY is not set.
// Run manually: ELEVENLABS_API_KEY=<key> npm run test -- test/integration/elevenlabs.test.ts

import { describe, it, expect } from "vitest";
import { ElevenLabsAdapter } from "../../src/adapters/elevenlabs/index.js";

const hasKey = Boolean(process.env.ELEVENLABS_API_KEY);

describe.skipIf(!hasKey)("ElevenLabsAdapter — real API (manual gate)", () => {
  it("synth() returns SynthResult with sampleRate 24000 and durationSamples > 0", async () => {
    const adapter = new ElevenLabsAdapter({ model: "eleven_multilingual_v2" });
    const result = await adapter.synth({
      text: "hello",
      voice: "21m00Tcm4TlvDq8ikWAM", // Rachel voice (publicly listed)
      sampleRate: 24000,
    });
    expect(result.sampleRate).toBe(24000);
    expect(result.durationSamples).toBeGreaterThan(0);
    expect(result.pcm).toBeInstanceOf(Float32Array);
    expect(result.pcm.length).toBe(result.durationSamples);
  }, 30000); // 30s timeout for real API
});
