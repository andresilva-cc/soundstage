// Unit tests for Phase B multi-chunk Voice clip emission (Task 7).
// Verifies contiguous placement, shared voiceUnitId, single-chunk parity.

import { describe, it, expect } from "vitest";
import { phaseB } from "../../src/ir/phase-b.js";
import type { SoundstageElement } from "../../src/jsx-runtime/index.js";
import type { ChunkResult } from "../../src/ir/phase-a.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SR = 48000;

function episode(children: SoundstageElement[]): SoundstageElement {
  return {
    type: "Episode",
    props: { title: "Chunk Test", sampleRate: SR },
    children,
  };
}

/**
 * Build a Voice node as Phase A would output after T7:
 * props contain voiceUnitId + chunks[] (no sourceRef/durationSamples).
 */
function multiChunkVoice(
  voiceUnitId: number,
  chunks: Array<{ durationSamples: number; hash: string }>,
): SoundstageElement {
  const chunkResults: ChunkResult[] = chunks.map(c => ({
    wavPath: `.soundstage/cache/${c.hash}.wav`,
    hash: c.hash,
    durationSamples: c.durationSamples,
    sampleRate: 24000,
    hit: false,
    originalText: "chunk text.",
  }));
  return {
    type: "Voice",
    props: { voice: "host", voiceUnitId, chunks: chunkResults },
    children: ["text."],
  };
}

/** Single-chunk Voice (most common case). */
function singleChunkVoice(durationSamples: number, voiceUnitId: number, hash = "abc"): SoundstageElement {
  return multiChunkVoice(voiceUnitId, [{ durationSamples, hash }]);
}

// ---------------------------------------------------------------------------
// AC: 3-chunk Voice → 3 sequential ClipIRs, all sharing voiceUnitId
// ---------------------------------------------------------------------------

describe("Phase B multi-chunk Voice", () => {
  it("3-chunk Voice emits 3 ClipIRs on the voice track", () => {
    const voice = multiChunkVoice(0, [
      { durationSamples: 10000, hash: "c1" },
      { durationSamples: 20000, hash: "c2" },
      { durationSamples: 15000, hash: "c3" },
    ]);
    const ir = phaseB(episode([voice]));
    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips).toHaveLength(3);
  });

  it("chunk[1].startSample === chunk[0].startSample + chunk[0].durationSamples (contiguous)", () => {
    const voice = multiChunkVoice(0, [
      { durationSamples: 10000, hash: "c1" },
      { durationSamples: 20000, hash: "c2" },
      { durationSamples: 15000, hash: "c3" },
    ]);
    const ir = phaseB(episode([voice]));
    const clips = ir.clips.filter(c => c.trackId === "voice");
    expect(clips[0]!.startSample).toBe(0);
    expect(clips[1]!.startSample).toBe(clips[0]!.startSample + clips[0]!.durationSamples);
    expect(clips[2]!.startSample).toBe(clips[1]!.startSample + clips[1]!.durationSamples);
  });

  it("all 3 ClipIRs share the same voiceUnitId", () => {
    const voice = multiChunkVoice(7, [
      { durationSamples: 5000, hash: "c1" },
      { durationSamples: 8000, hash: "c2" },
      { durationSamples: 6000, hash: "c3" },
    ]);
    const ir = phaseB(episode([voice]));
    const clips = ir.clips.filter(c => c.trackId === "voice");
    for (const clip of clips) {
      expect(clip.sourceRef.voiceUnitId).toBe(7);
    }
  });

  it("total Voice duration = sum of chunk durations", () => {
    const voice = multiChunkVoice(0, [
      { durationSamples: 10000, hash: "c1" },
      { durationSamples: 20000, hash: "c2" },
      { durationSamples: 15000, hash: "c3" },
    ]);
    const ir = phaseB(episode([voice]));
    const clips = ir.clips.filter(c => c.trackId === "voice");
    const lastClip = clips[clips.length - 1]!;
    const totalDuration = lastClip.startSample + lastClip.durationSamples;
    expect(totalDuration).toBe(10000 + 20000 + 15000); // 45000
  });

  it("each ClipIR sourceRef.path matches the corresponding chunk's wavPath", () => {
    const voice = multiChunkVoice(0, [
      { durationSamples: 5000, hash: "hash1" },
      { durationSamples: 8000, hash: "hash2" },
    ]);
    const ir = phaseB(episode([voice]));
    const clips = ir.clips.filter(c => c.trackId === "voice");
    expect(clips[0]!.sourceRef.path).toBe(".soundstage/cache/hash1.wav");
    expect(clips[1]!.sourceRef.path).toBe(".soundstage/cache/hash2.wav");
  });

  it("each ClipIR sourceRef.hash matches the corresponding chunk's hash", () => {
    const voice = multiChunkVoice(0, [
      { durationSamples: 5000, hash: "aaaa" },
      { durationSamples: 8000, hash: "bbbb" },
    ]);
    const ir = phaseB(episode([voice]));
    const clips = ir.clips.filter(c => c.trackId === "voice");
    expect(clips[0]!.sourceRef.hash).toBe("aaaa");
    expect(clips[1]!.sourceRef.hash).toBe("bbbb");
  });
});

// ---------------------------------------------------------------------------
// AC: Two multi-chunk Voices are placed sequentially
// ---------------------------------------------------------------------------

describe("Two multi-chunk Voices sequential placement", () => {
  it("second Voice's first chunk starts after first Voice's last chunk ends", () => {
    const voice0 = multiChunkVoice(0, [
      { durationSamples: 10000, hash: "v0c1" },
      { durationSamples: 15000, hash: "v0c2" },
    ]);
    const voice1 = multiChunkVoice(1, [
      { durationSamples: 8000, hash: "v1c1" },
      { durationSamples: 12000, hash: "v1c2" },
    ]);
    const ir = phaseB(episode([voice0, voice1]));
    const clips = ir.clips.filter(c => c.trackId === "voice");

    // v0: chunk0 @ 0, chunk1 @ 10000
    expect(clips[0]!.startSample).toBe(0);
    expect(clips[1]!.startSample).toBe(10000);
    // v1: chunk0 @ 25000 (= 10000+15000), chunk1 @ 33000 (= 25000+8000)
    expect(clips[2]!.startSample).toBe(25000);
    expect(clips[3]!.startSample).toBe(33000);
  });

  it("each multi-chunk Voice keeps its own voiceUnitId across chunks", () => {
    const voice0 = multiChunkVoice(0, [
      { durationSamples: 10000, hash: "v0c1" },
      { durationSamples: 15000, hash: "v0c2" },
    ]);
    const voice1 = multiChunkVoice(1, [
      { durationSamples: 8000, hash: "v1c1" },
    ]);
    const ir = phaseB(episode([voice0, voice1]));
    const clips = ir.clips.filter(c => c.trackId === "voice");
    expect(clips[0]!.sourceRef.voiceUnitId).toBe(0);
    expect(clips[1]!.sourceRef.voiceUnitId).toBe(0);
    expect(clips[2]!.sourceRef.voiceUnitId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC: Single-chunk Voice behavior is identical to pre-T7 (modulo schema)
// ---------------------------------------------------------------------------

describe("Single-chunk Voice parity", () => {
  it("1-chunk Voice → 1 ClipIR on voice track", () => {
    const voice = singleChunkVoice(100000, 0, "ha");
    const ir = phaseB(episode([voice]));
    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips).toHaveLength(1);
    expect(voiceClips[0]!.startSample).toBe(0);
    expect(voiceClips[0]!.durationSamples).toBe(100000);
    expect(voiceClips[0]!.sourceRef.voiceUnitId).toBe(0);
  });

  it("two single-chunk Voices place sequentially as before", () => {
    const v0 = singleChunkVoice(100000, 0, "ha");
    const v1 = singleChunkVoice(80000, 1, "hb");
    const ir = phaseB(episode([v0, v1]));
    const clips = ir.clips.filter(c => c.trackId === "voice");
    expect(clips).toHaveLength(2);
    expect(clips[0]!.startSample).toBe(0);
    expect(clips[1]!.startSample).toBe(100000);
  });

  it("Segment chapter startSample/endSample use first/last chunk of the multi-chunk Voice", () => {
    const voice = multiChunkVoice(0, [
      { durationSamples: 10000, hash: "c1" },
      { durationSamples: 20000, hash: "c2" },
      { durationSamples: 15000, hash: "c3" },
    ]);
    const segment = {
      type: "Segment",
      props: { title: "Intro" },
      children: [voice],
    } as SoundstageElement;
    const ir = phaseB(episode([segment]));

    expect(ir.chapters).toHaveLength(1);
    const ch = ir.chapters[0]!;
    expect(ch.title).toBe("Intro");
    expect(ch.startSample).toBe(0); // first chunk's startSample
    expect(ch.endSample).toBe(45000); // (0+10000+20000) + 15000
  });
});

// ---------------------------------------------------------------------------
// FIX 1 regression: Crossfade + multi-chunk Voice — check is against FIRST chunk
// acrossfade blends the last preceding clip with the FIRST following clip only.
// The constraint is: overlap ≤ first chunk's durationSamples (not sum of all chunks).
// ---------------------------------------------------------------------------

describe("Crossfade guard against multi-chunk Voice — first chunk is the boundary", () => {
  it("crossfade > first chunk of following multi-chunk Voice → E_CROSSFADE_DURATION", () => {
    // Preceding Voice: one chunk, 200000 samples (well clear of the crossfade)
    const preceding = singleChunkVoice(200000, 0, "prev");
    const crossfade: SoundstageElement = {
      type: "Crossfade",
      props: { duration: 0.75 }, // 0.75s × 48000 = 36000 samples
      children: [],
    };
    // Following Voice: 2 chunks — first chunk is 10000 samples (< 36000), second is long
    const following = multiChunkVoice(1, [
      { durationSamples: 10000, hash: "small-first-chunk" }, // < crossfade duration
      { durationSamples: 100000, hash: "large-second-chunk" },
    ]);

    expect(() => phaseB(episode([preceding, crossfade, following]))).toThrow(
      expect.objectContaining({ code: "E_CROSSFADE_DURATION" }),
    );
  });

  it("crossfade ≤ first chunk of following multi-chunk Voice → does NOT throw", () => {
    // Preceding Voice: one chunk, 200000 samples
    const preceding = singleChunkVoice(200000, 0, "prev");
    const crossfade: SoundstageElement = {
      type: "Crossfade",
      props: { duration: 0.2 }, // 0.2s × 48000 = 9600 samples
      children: [],
    };
    // Following Voice: 2 chunks — first chunk is 20000 samples (> 9600), second is long
    const following = multiChunkVoice(1, [
      { durationSamples: 20000, hash: "long-enough-first-chunk" }, // ≥ crossfade
      { durationSamples: 100000, hash: "large-second-chunk" },
    ]);

    // Must not throw — crossfade fits within the first chunk
    expect(() => phaseB(episode([preceding, crossfade, following]))).not.toThrow();
  });

  it("crossfade ≤ first chunk but total Voice is longer → does NOT throw (no false positive)", () => {
    // Ensures we never accidentally reject based on total Voice duration or any other value
    const preceding = singleChunkVoice(200000, 0, "prev");
    const crossfade: SoundstageElement = {
      type: "Crossfade",
      props: { duration: 0.3 }, // 14400 samples
      children: [],
    };
    const following = multiChunkVoice(1, [
      { durationSamples: 20000, hash: "c0" }, // 20000 ≥ 14400 → OK
      { durationSamples: 5000, hash: "c1" },  // total = 25000, but check is on c0 only
      { durationSamples: 8000, hash: "c2" },
    ]);

    expect(() => phaseB(episode([preceding, crossfade, following]))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FIX 4: originalText must NOT appear in the IR (it lives in resolved tree only)
// ---------------------------------------------------------------------------

describe("Phase B IR — originalText is not carried into IR", () => {
  it("IR JSON has no originalText field even when ChunkResult has originalText", () => {
    const voice = multiChunkVoice(0, [
      { durationSamples: 10000, hash: "c1" },
      { durationSamples: 20000, hash: "c2" },
    ]);
    const ir = phaseB(episode([voice]));
    const serialized = JSON.stringify(ir);
    expect(serialized).not.toContain("originalText");
  });
});
