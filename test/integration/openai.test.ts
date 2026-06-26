// Integration test for the real OpenAI TTS API.
// MANUAL / GATED: skipped when OPENAI_API_KEY is not set.
// Run manually: OPENAI_API_KEY=sk-... npm run test -- test/integration/openai.test.ts

import { describe, it, expect } from "vitest";
import { OpenAiAdapter } from "../../src/adapters/openai/index.js";

const hasKey = Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!hasKey)("OpenAiAdapter — real API (manual gate)", () => {
  it("synth() returns SynthResult with sampleRate 24000 and durationSamples > 0", async () => {
    const adapter = new OpenAiAdapter();
    const result = await adapter.synth({
      text: "hello",
      voice: "alloy",
      sampleRate: 24000,
    });
    expect(result.sampleRate).toBe(24000);
    expect(result.durationSamples).toBeGreaterThan(0);
    expect(result.pcm).toBeInstanceOf(Float32Array);
    expect(result.pcm.length).toBe(result.durationSamples);
  });
});
