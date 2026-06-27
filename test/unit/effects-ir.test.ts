// Unit tests for Task 5: Per-Clip Effects (EQ + Compression) — IR lowering.
// Covers: ClipIR.effects undefined by default; eq/compress props → effects[];
//         declaration order; Clip vs Voice parity; validation errors.

import { describe, it, expect } from "vitest";
import { phaseB } from "../../src/ir/phase-b.js";
import { validateTree } from "../../src/ir/validate.js";
import type { SoundstageElement } from "../../src/jsx-runtime/index.js";

const SR = 48000;

// ---------------------------------------------------------------------------
// Fixture builders — hand-constructed resolved-tree nodes (Phase A output shape)
// ---------------------------------------------------------------------------

function episode(children: SoundstageElement[]): SoundstageElement {
  return {
    type: "Episode",
    props: { title: "Test", sampleRate: SR },
    children,
  };
}

function voiceNode(
  durationSamples: number,
  extraProps: Record<string, unknown> = {},
): SoundstageElement {
  return {
    type: "Voice",
    props: {
      voice: "host",
      voiceUnitId: 0,
      chunks: [{ wavPath: ".soundstage/cache/abc.wav", hash: "abc", durationSamples, sampleRate: 48000, hit: false, originalText: "some text." }],
      ...extraProps,
    },
    children: ["some text"],
  };
}

function clipNode(
  durationSamples: number,
  extraProps: Record<string, unknown> = {},
): SoundstageElement {
  return {
    type: "Clip",
    props: {
      src: "/clips/a.wav",
      sourceRef: { kind: "file", path: "/clips/a.wav" },
      durationSamples,
      ...extraProps,
    },
    children: [],
  };
}

// ---------------------------------------------------------------------------
// ClipIR.effects — undefined by default
// ---------------------------------------------------------------------------

describe("ClipIR.effects — absent by default", () => {
  it("effects is undefined on a Voice clip with no eq or compress props", () => {
    const tree = episode([voiceNode(SR)]);
    const ir = phaseB(tree);
    const clip = ir.clips.find(c => c.trackId === "voice");
    expect(clip).toBeDefined();
    expect(clip!.effects).toBeUndefined();
  });

  it("effects is undefined on a Clip node with no eq or compress props", () => {
    const tree = episode([clipNode(SR)]);
    const ir = phaseB(tree);
    const clip = ir.clips.find(c => c.trackId === "voice");
    expect(clip!.effects).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EQ prop → effects
// ---------------------------------------------------------------------------

describe("<Voice eq> → ClipIR.effects eq entry", () => {
  it("eq prop produces effects: [{ type:'eq', bands:[...] }]", () => {
    const eq = [{ frequency: 1000, gain: -3, width: 1 }];
    const tree = episode([voiceNode(SR, { eq })]);
    const ir = phaseB(tree);
    const clip = ir.clips[0]!;
    expect(clip.effects).toHaveLength(1);
    expect(clip.effects![0]).toEqual({ type: "eq", bands: [{ frequency: 1000, gain: -3, width: 1 }] });
  });

  it("eq with multiple bands is preserved", () => {
    const eq = [
      { frequency: 200, gain: -2, width: 2 },
      { frequency: 1000, gain: -6, width: 1 },
    ];
    const tree = episode([voiceNode(SR, { eq })]);
    const ir = phaseB(tree);
    expect(ir.clips[0]!.effects![0]).toEqual({ type: "eq", bands: eq });
  });
});

// ---------------------------------------------------------------------------
// Compress prop → effects
// ---------------------------------------------------------------------------

describe("<Voice compress> → ClipIR.effects compress entry", () => {
  it("compress prop produces effects: [{ type:'compress', ... }]", () => {
    const compress = { threshold: -20, ratio: 4, attack: 5, release: 100, knee: 2 };
    const tree = episode([voiceNode(SR, { compress })]);
    const ir = phaseB(tree);
    const clip = ir.clips[0]!;
    expect(clip.effects).toHaveLength(1);
    expect(clip.effects![0]).toEqual({ type: "compress", ...compress });
  });
});

// ---------------------------------------------------------------------------
// Multiple effects — declaration order
// ---------------------------------------------------------------------------

describe("multiple effects — declaration order preserved", () => {
  it("eq then compress → effects[0]=eq, effects[1]=compress", () => {
    const eq = [{ frequency: 1000, gain: -3, width: 1 }];
    const compress = { threshold: -20, ratio: 4, attack: 5, release: 100, knee: 2 };
    const tree = episode([voiceNode(SR, { eq, compress })]);
    const ir = phaseB(tree);
    const clip = ir.clips[0]!;
    expect(clip.effects).toHaveLength(2);
    expect(clip.effects![0]!.type).toBe("eq");
    expect(clip.effects![1]!.type).toBe("compress");
  });
});

// ---------------------------------------------------------------------------
// Effects on <Clip src> — parity with <Voice>
// ---------------------------------------------------------------------------

describe("effects on <Clip src> — same as <Voice>", () => {
  it("<Clip eq> produces effects eq entry", () => {
    const eq = [{ frequency: 500, gain: -6, width: 1 }];
    const tree = episode([clipNode(SR, { eq })]);
    const ir = phaseB(tree);
    const clip = ir.clips[0]!;
    expect(clip.effects).toHaveLength(1);
    expect(clip.effects![0]).toEqual({ type: "eq", bands: eq });
  });

  it("<Clip compress> produces effects compress entry", () => {
    const compress = { threshold: -18, ratio: 3, attack: 10, release: 200, knee: 5 };
    const tree = episode([clipNode(SR, { compress })]);
    const ir = phaseB(tree);
    const clip = ir.clips[0]!;
    expect(clip.effects).toHaveLength(1);
    expect(clip.effects![0]).toEqual({ type: "compress", ...compress });
  });
});

// ---------------------------------------------------------------------------
// Validation — EQ prop errors
// ---------------------------------------------------------------------------

describe("validation — eq prop errors", () => {
  function voiceEl(extraProps: Record<string, unknown>): SoundstageElement {
    return {
      type: "Episode",
      props: { title: "Test" },
      children: [
        {
          type: "Voice",
          props: { voice: "host", ...extraProps },
          children: ["text"],
        },
      ],
    };
  }

  it("eq frequency ≤ 0 throws E_INVALID_PROP", () => {
    const tree = voiceEl({ eq: [{ frequency: 0, gain: -3, width: 1 }] });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("eq frequency NaN throws E_INVALID_PROP", () => {
    const tree = voiceEl({ eq: [{ frequency: NaN, gain: -3, width: 1 }] });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("eq frequency negative throws E_INVALID_PROP", () => {
    const tree = voiceEl({ eq: [{ frequency: -100, gain: -3, width: 1 }] });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("eq gain NaN throws E_INVALID_PROP", () => {
    const tree = voiceEl({ eq: [{ frequency: 1000, gain: NaN, width: 1 }] });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("eq gain Infinity throws E_INVALID_PROP", () => {
    const tree = voiceEl({ eq: [{ frequency: 1000, gain: Infinity, width: 1 }] });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("eq width ≤ 0 throws E_INVALID_PROP", () => {
    const tree = voiceEl({ eq: [{ frequency: 1000, gain: -3, width: 0 }] });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("eq width NaN throws E_INVALID_PROP", () => {
    const tree = voiceEl({ eq: [{ frequency: 1000, gain: -3, width: NaN }] });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Validation — compress prop errors
// ---------------------------------------------------------------------------

describe("validation — compress prop errors", () => {
  function voiceEl(extraProps: Record<string, unknown>): SoundstageElement {
    return {
      type: "Episode",
      props: { title: "Test" },
      children: [
        {
          type: "Voice",
          props: { voice: "host", ...extraProps },
          children: ["text"],
        },
      ],
    };
  }

  it("compressor ratio < 1.0 throws E_INVALID_PROP", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 0.5, attack: 5, release: 100, knee: 2 } });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("compressor ratio = 0 throws E_INVALID_PROP", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 0, attack: 5, release: 100, knee: 2 } });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("compressor attack ≤ 0 throws E_INVALID_PROP", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 4, attack: 0, release: 100, knee: 2 } });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("compressor attack NaN throws E_INVALID_PROP", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 4, attack: NaN, release: 100, knee: 2 } });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("compressor release ≤ 0 throws E_INVALID_PROP", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 4, attack: 5, release: 0, knee: 2 } });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("compressor release NaN throws E_INVALID_PROP", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 4, attack: 5, release: NaN, knee: 2 } });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  // Valid compressor at ratio = 1.0 should NOT throw
  it("compressor ratio = 1.0 is valid (boundary)", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 1.0, attack: 5, release: 100, knee: 2 } });
    expect(() => validateTree(tree, process.cwd())).not.toThrow();
  });

  // threshold validation
  it("compressor threshold NaN throws E_INVALID_PROP", () => {
    const tree = voiceEl({ compress: { threshold: NaN, ratio: 4, attack: 5, release: 100, knee: 2 } });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("compressor threshold Infinity throws E_INVALID_PROP", () => {
    const tree = voiceEl({ compress: { threshold: Infinity, ratio: 4, attack: 5, release: 100, knee: 2 } });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  // knee validation (ffmpeg range [1, 8])
  it("compressor knee < 1 throws E_INVALID_PROP", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 4, attack: 5, release: 100, knee: 0.5 } });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("compressor knee > 8 throws E_INVALID_PROP", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 4, attack: 5, release: 100, knee: 9 } });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("compressor knee NaN throws E_INVALID_PROP", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 4, attack: 5, release: 100, knee: NaN } });
    expect(() => validateTree(tree, process.cwd())).toThrowError(
      expect.objectContaining({ code: "E_INVALID_PROP" }),
    );
  });

  it("compressor knee at boundary 1 is valid", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 4, attack: 5, release: 100, knee: 1 } });
    expect(() => validateTree(tree, process.cwd())).not.toThrow();
  });

  it("compressor knee at boundary 8 is valid", () => {
    const tree = voiceEl({ compress: { threshold: -20, ratio: 4, attack: 5, release: 100, knee: 8 } });
    expect(() => validateTree(tree, process.cwd())).not.toThrow();
  });
});

