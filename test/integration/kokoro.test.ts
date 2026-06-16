// Integration test for KokoroAdapter — SKIPPED in CI (NO_KOKORO=1).
// When run locally with kokoro-js installed and model cached, this test:
//   - synthesizes a short phrase
//   - asserts sampleRate=24000, non-empty Float32Array, durationSamples===pcm.length
//   - asserts byte-determinism: two synths of the same text produce identical pcm

import { beforeAll, it, expect } from "vitest";
import { KokoroAdapter } from "../../src/adapters/kokoro/index.js";
import type { SynthRequest } from "../../src/adapters/types.js";

// kokoroAvailable: determined at runtime in beforeAll.
// Starts false; set to true only when kokoro-js loads and a probe synth succeeds.
let kokoroAvailable = false;

beforeAll(async () => {
  if (process.env.NO_KOKORO) {
    return; // CI gate — leave kokoroAvailable false
  }
  try {
    await import("kokoro-js");
    const probe = new KokoroAdapter();
    await probe.synth({ text: "test", voice: "af_heart", sampleRate: 24000 });
    kokoroAvailable = true;
  } catch {
    kokoroAvailable = false;
  }
}, 120_000);

const adapter = new KokoroAdapter();

const baseReq: SynthRequest = {
  text: "Hello from Soundstage.",
  voice: "af_heart",
  sampleRate: 24000,
};

// Skipped unconditionally in CI via NO_KOKORO. On other machines, skip if the
// probe in beforeAll failed (missing model, missing kokoro-js, etc.).
// Using ctx.skip() so a genuine Kokoro failure when kokoroAvailable=true is a real FAIL.
it.skipIf(process.env.NO_KOKORO)("KokoroAdapter: synth returns 24kHz mono PCM", async (ctx) => {
  if (!kokoroAvailable) {
    ctx.skip();
    return;
  }
  const result = await adapter.synth(baseReq);

  expect(result.sampleRate).toBe(24000);
  expect(result.pcm).toBeInstanceOf(Float32Array);
  expect(result.pcm.length).toBeGreaterThan(0);
  expect(result.durationSamples).toBe(result.pcm.length);
}, 60_000);

it.skipIf(process.env.NO_KOKORO)("KokoroAdapter: synth is byte-deterministic", async (ctx) => {
  if (!kokoroAvailable) {
    ctx.skip();
    return;
  }
  const r1 = await adapter.synth(baseReq);
  const r2 = await adapter.synth(baseReq);

  expect(r1.pcm.length).toBe(r2.pcm.length);
  expect(Buffer.from(r1.pcm.buffer).equals(Buffer.from(r2.pcm.buffer))).toBe(true);
}, 120_000);
