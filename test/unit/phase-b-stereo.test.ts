// Unit tests for Task 3: Stereo Audio End-to-End — IR and validation.
// Covers: IR.channels, ClipIR.pan, phaseB() prop extraction, validation rules,
//         SCHEMA_VERSION bump.

import { describe, it, expect } from "vitest";
import { phaseB } from "../../src/ir/phase-b.js";
import { SCHEMA_VERSION } from "../../src/schema-version.js";
import { validateTree } from "../../src/ir/validate.js";
import { SoundstageError } from "../../src/ir/errors.js";
import { jsx, jsxs } from "../../src/jsx-runtime/index.js";
import type { SoundstageElement } from "../../src/jsx-runtime/index.js";

const SR = 48000;

// ---------------------------------------------------------------------------
// Fixture builders — hand-constructed resolved-tree nodes (Phase A output shape)
// ---------------------------------------------------------------------------

function episode(
  children: SoundstageElement[],
  opts: { sampleRate?: number; channels?: number } = {},
): SoundstageElement {
  return {
    type: "Episode",
    props: {
      title: "Test Episode",
      sampleRate: opts.sampleRate ?? SR,
      ...(opts.channels !== undefined ? { channels: opts.channels } : {}),
    },
    children,
  };
}

function voiceNode(
  durationSamples: number,
  voiceUnitId = 0,
  hash = "abc123",
  pan?: number,
): SoundstageElement {
  return {
    type: "Voice",
    props: {
      voice: "host",
      voiceUnitId,
      chunks: [{ wavPath: `.soundstage/cache/${hash}.wav`, hash, durationSamples, sampleRate: 48000, hit: false }],
      ...(pan !== undefined ? { pan } : {}),
    },
    children: ["some text"],
  };
}

function clipNode(durationSamples: number, pan?: number): SoundstageElement {
  return {
    type: "Clip",
    props: {
      src: "/clips/a.wav",
      sourceRef: { kind: "file", path: "/clips/a.wav" },
      durationSamples,
      ...(pan !== undefined ? { pan } : {}),
    },
    children: [],
  };
}

function musicBedNode(children: SoundstageElement[], pan?: number): SoundstageElement {
  return {
    type: "MusicBed",
    props: {
      src: "bed.mp3",
      duck: -12,
      sourceRef: { kind: "file", path: "/abs/bed.mp3" },
      durationSamples: 48000,
      ...(pan !== undefined ? { pan } : {}),
    },
    children,
  };
}

// ---------------------------------------------------------------------------
// SCHEMA_VERSION
// ---------------------------------------------------------------------------

describe("SCHEMA_VERSION", () => {
  it("SCHEMA_VERSION === 4", () => {
    expect(SCHEMA_VERSION).toBe(4);
  });

  it("phaseB produces schemaVersion 4", () => {
    const tree = episode([voiceNode(SR)]);
    const ir = phaseB(tree);
    expect(ir.schemaVersion).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// IR.channels
// ---------------------------------------------------------------------------

describe("IR.channels", () => {
  it("channels === 1 when <Episode> has no channels prop", () => {
    const tree = episode([voiceNode(SR)]);
    const ir = phaseB(tree);
    expect(ir.channels).toBe(1);
  });

  it("channels === 2 when <Episode channels={2}>", () => {
    const tree = episode([voiceNode(SR)], { channels: 2 });
    const ir = phaseB(tree);
    expect(ir.channels).toBe(2);
  });

  it("channels === 1 when <Episode channels={1}>", () => {
    const tree = episode([voiceNode(SR)], { channels: 1 });
    const ir = phaseB(tree);
    expect(ir.channels).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ClipIR.pan
// ---------------------------------------------------------------------------

describe("ClipIR.pan", () => {
  it("pan is undefined on a Voice clip when no pan prop is set", () => {
    const tree = episode([voiceNode(SR)]);
    const ir = phaseB(tree);
    const clip = ir.clips.find(c => c.trackId === "voice");
    expect(clip).toBeDefined();
    expect(clip!.pan).toBeUndefined();
  });

  it("pan equals prop value when set on Voice", () => {
    const tree = episode([voiceNode(SR, 0, "h1", 0.5)]);
    const ir = phaseB(tree);
    const clip = ir.clips.find(c => c.trackId === "voice");
    expect(clip!.pan).toBe(0.5);
  });

  it("pan is -1.0 when set full-left on Voice", () => {
    const tree = episode([voiceNode(SR, 0, "h1", -1.0)]);
    const ir = phaseB(tree);
    expect(ir.clips[0]!.pan).toBe(-1.0);
  });

  it("pan is undefined on a Clip node when no pan prop", () => {
    const tree = episode([clipNode(SR)]);
    const ir = phaseB(tree);
    const clip = ir.clips.find(c => c.trackId === "voice");
    expect(clip!.pan).toBeUndefined();
  });

  it("pan equals prop value when set on Clip", () => {
    const tree = episode([clipNode(SR, 0.25)]);
    const ir = phaseB(tree);
    expect(ir.clips[0]!.pan).toBe(0.25);
  });

  it("pan is undefined on a MusicBed clip when no pan prop", () => {
    const tree = episode([musicBedNode([voiceNode(SR)])]);
    const ir = phaseB(tree);
    const bedClip = ir.clips.find(c => c.trackId === "bed-0");
    expect(bedClip!.pan).toBeUndefined();
  });

  it("pan equals prop value when set on MusicBed", () => {
    const tree = episode([musicBedNode([voiceNode(SR)], -0.5)]);
    const ir = phaseB(tree);
    const bedClip = ir.clips.find(c => c.trackId === "bed-0");
    expect(bedClip!.pan).toBe(-0.5);
  });
});

// ---------------------------------------------------------------------------
// Validation: channels prop on <Episode>
// ---------------------------------------------------------------------------

// Helper to build a raw (non-resolved) tree for validateTree
function rawEpisode(
  channels: unknown,
  ...children: SoundstageElement[]
): SoundstageElement {
  return jsxs(
    "Episode",
    { title: "Test", channels, children },
    undefined,
  );
}

function rawVoice(pan?: unknown): SoundstageElement {
  return jsx("Voice", { voice: "host", pan }, undefined);
}

function rawClipEl(pan?: unknown): SoundstageElement {
  return jsx("Clip", { src: "/nonexistent.wav", pan }, undefined);
}

function rawMusicBedEl(pan?: unknown): SoundstageElement {
  return jsxs("MusicBed", { src: "/nonexistent.mp3", pan, children: [] }, undefined);
}

describe("validation: channels prop on <Episode>", () => {
  it("channels=3 throws E_INVALID_PROP", () => {
    const tree = rawEpisode(3, rawVoice());
    expect(() => validateTree(tree)).toThrow(SoundstageError);
    expect(() => validateTree(tree)).toThrow(/\[E_INVALID_PROP\]/);
  });

  it("channels=0 throws E_INVALID_PROP", () => {
    const tree = rawEpisode(0, rawVoice());
    expect(() => validateTree(tree)).toThrow(SoundstageError);
    expect(() => validateTree(tree)).toThrow(/\[E_INVALID_PROP\]/);
  });

  it("channels=1.5 throws E_INVALID_PROP", () => {
    const tree = rawEpisode(1.5, rawVoice());
    expect(() => validateTree(tree)).toThrow(SoundstageError);
    expect(() => validateTree(tree)).toThrow(/\[E_INVALID_PROP\]/);
  });

  it("channels=1 is valid (no throw)", () => {
    // Need a valid voice — use a file that won't be checked (baseDir irrelevant)
    // We just test that the channels check itself passes for valid value.
    // Episode with channels=1 must not throw for the channels check.
    // NOTE: validateTree also checks src existence, but channels is validated first.
    const tree = jsxs(
      "Episode",
      { title: "Test", channels: 1, children: [] },
      undefined,
    );
    // No children → no src checks, just channels check
    expect(() => validateTree(tree)).not.toThrow();
  });

  it("channels=2 is valid (no throw)", () => {
    const tree = jsxs(
      "Episode",
      { title: "Test", channels: 2, children: [] },
      undefined,
    );
    expect(() => validateTree(tree)).not.toThrow();
  });

  it("no channels prop is valid (no throw)", () => {
    const tree = jsxs(
      "Episode",
      { title: "Test", children: [] },
      undefined,
    );
    expect(() => validateTree(tree)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation: pan prop on <Voice>, <Clip>, <MusicBed>
// ---------------------------------------------------------------------------

describe("validation: pan prop", () => {
  it("<Voice pan={2.0}> throws E_INVALID_PROP", () => {
    const tree = jsxs(
      "Episode",
      { title: "T", children: [jsx("Voice", { voice: "host", pan: 2.0 }, undefined)] },
      undefined,
    );
    expect(() => validateTree(tree)).toThrow(SoundstageError);
    expect(() => validateTree(tree)).toThrow(/\[E_INVALID_PROP\]/);
  });

  it("<Voice pan={NaN}> throws E_INVALID_PROP", () => {
    const tree = jsxs(
      "Episode",
      { title: "T", children: [jsx("Voice", { voice: "host", pan: NaN }, undefined)] },
      undefined,
    );
    expect(() => validateTree(tree)).toThrow(SoundstageError);
    expect(() => validateTree(tree)).toThrow(/\[E_INVALID_PROP\]/);
  });

  it("<Voice pan={-1.5}> throws E_INVALID_PROP", () => {
    const tree = jsxs(
      "Episode",
      { title: "T", children: [jsx("Voice", { voice: "host", pan: -1.5 }, undefined)] },
      undefined,
    );
    expect(() => validateTree(tree)).toThrow(SoundstageError);
    expect(() => validateTree(tree)).toThrow(/\[E_INVALID_PROP\]/);
  });

  it("<Voice pan={0.0}> is valid", () => {
    const tree = jsxs(
      "Episode",
      { title: "T", children: [jsx("Voice", { voice: "host", pan: 0.0 }, undefined)] },
      undefined,
    );
    // Will fail E_MISSING_PROP for voice's text but that's ok — pan validation must pass
    // Actually validate doesn't check voice text, only required props. voice is required,
    // it IS set. So this should not throw at all (no children to validate).
    // But wait, validate.ts checks that the tree has no E_MISSING_PROP for voice prop.
    // voice="host" is set so it's fine. No E_INVALID_PROP for valid pan.
    // It may throw for other reasons if we have children with src — but we have none.
    expect(() => validateTree(tree)).not.toThrow();
  });

  it("<Voice pan={-1.0}> is valid", () => {
    const tree = jsxs(
      "Episode",
      { title: "T", children: [jsx("Voice", { voice: "host", pan: -1.0 }, undefined)] },
      undefined,
    );
    expect(() => validateTree(tree)).not.toThrow();
  });

  it("<Voice pan={1.0}> is valid", () => {
    const tree = jsxs(
      "Episode",
      { title: "T", children: [jsx("Voice", { voice: "host", pan: 1.0 }, undefined)] },
      undefined,
    );
    expect(() => validateTree(tree)).not.toThrow();
  });

  it("<Clip pan={2.0}> throws E_INVALID_PROP", () => {
    const tree = jsxs("Episode", { title: "T", children: [rawClipEl(2.0)] }, undefined);
    expect(() => validateTree(tree)).toThrow(SoundstageError);
    expect(() => validateTree(tree)).toThrow(/\[E_INVALID_PROP\]/);
  });

  it("<MusicBed pan={NaN}> throws E_INVALID_PROP", () => {
    const tree = jsxs("Episode", { title: "T", children: [rawMusicBedEl(NaN)] }, undefined);
    expect(() => validateTree(tree)).toThrow(SoundstageError);
    expect(() => validateTree(tree)).toThrow(/\[E_INVALID_PROP\]/);
  });
});
