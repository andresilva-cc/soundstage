import { describe, it, expect } from "vitest";
import { jsxs } from "../src/jsx-runtime/index.ts";
import type { SoundstageElement } from "../src/jsx-runtime/index.ts";
import { resolveInheritance } from "../src/ir/inherit.ts";
import { SoundstageError } from "../src/ir/errors.ts";

// Helpers
function episode(props: Record<string, unknown>, ...children: SoundstageElement[]): SoundstageElement {
  return jsxs("Episode", { title: "Test", ...props, children }, undefined);
}

function segment(props: Record<string, unknown>, ...children: SoundstageElement[]): SoundstageElement {
  return jsxs("Segment", { ...props, children }, undefined);
}

function voice(props: Record<string, unknown>, ...textChildren: string[]): SoundstageElement {
  return jsxs("Voice", { ...props, children: textChildren }, undefined);
}

function musicBed(src: string, props: Record<string, unknown>, ...children: SoundstageElement[]): SoundstageElement {
  return jsxs("MusicBed", { src, ...props, children }, undefined);
}

// AC2 — <Voice> inherits voice/speed from nearest <Segment> ancestor; explicit <Voice voice> overrides
describe("inheritance — basic voice/speed inheritance from Segment", () => {
  it("Voice inherits voice from enclosing Segment when Voice has no voice prop", () => {
    const tree = episode({},
      segment({ voice: "host" },
        voice({}, "Hello"),
      ),
    );
    const resolved = resolveInheritance(tree);
    const seg = resolved.children[0] as SoundstageElement;
    const voiceEl = seg.children[0] as SoundstageElement;
    expect(voiceEl.props["voice"]).toBe("host");
  });

  it("Voice inherits speed from enclosing Segment", () => {
    const tree = episode({},
      segment({ voice: "host", speed: 1.2 },
        voice({}, "Hello"),
      ),
    );
    const resolved = resolveInheritance(tree);
    const seg = resolved.children[0] as SoundstageElement;
    const voiceEl = seg.children[0] as SoundstageElement;
    expect(voiceEl.props["voice"]).toBe("host");
    expect(voiceEl.props["speed"]).toBe(1.2);
  });

  it("explicit voice prop on Voice overrides Segment voice", () => {
    const tree = episode({},
      segment({ voice: "host" },
        voice({ voice: "guest" }, "Hello"),
      ),
    );
    const resolved = resolveInheritance(tree);
    const seg = resolved.children[0] as SoundstageElement;
    const voiceEl = seg.children[0] as SoundstageElement;
    expect(voiceEl.props["voice"]).toBe("guest");
  });

  it("explicit speed prop on Voice overrides Segment speed", () => {
    const tree = episode({},
      segment({ voice: "host", speed: 1.2 },
        voice({ voice: "host", speed: 0.9 }, "Hello"),
      ),
    );
    const resolved = resolveInheritance(tree);
    const seg = resolved.children[0] as SoundstageElement;
    const voiceEl = seg.children[0] as SoundstageElement;
    expect(voiceEl.props["speed"]).toBe(0.9);
  });

  it("Voice inherits voice from Episode when no Segment present", () => {
    const tree = episode({ voice: "narrator" },
      voice({}, "Hello"),
    );
    const resolved = resolveInheritance(tree);
    const voiceEl = resolved.children[0] as SoundstageElement;
    expect(voiceEl.props["voice"]).toBe("narrator");
  });
});

// AC3 — <Voice> nested two levels deep inherits nearest ancestor (not Episode's)
describe("inheritance — nearest-ancestor wins", () => {
  it("nested Voice inherits from nearest Segment, not Episode", () => {
    const tree = episode({ voice: "episode-narrator" },
      segment({ voice: "segment-host" },
        voice({}, "Hello"),
      ),
    );
    const resolved = resolveInheritance(tree);
    const seg = resolved.children[0] as SoundstageElement;
    const voiceEl = seg.children[0] as SoundstageElement;
    // nearest ancestor is Segment with voice "segment-host"
    expect(voiceEl.props["voice"]).toBe("segment-host");
  });

  it("two levels of Segment — innermost Segment wins", () => {
    // Simulated with MusicBed wrapping, but using Segments with children Segments isn't standard.
    // Test with Episode voice vs Segment voice — Segment is nearer.
    const inner = segment({ voice: "inner-host" },
      voice({}, "Deep voice"),
    );
    const outer = segment({ voice: "outer-host" },
      inner,
    );
    const tree = episode({ voice: "episode-host" }, outer);

    const resolved = resolveInheritance(tree);
    const outerSeg = resolved.children[0] as SoundstageElement;
    const innerSeg = outerSeg.children[0] as SoundstageElement;
    const voiceEl = innerSeg.children[0] as SoundstageElement;
    // inner Segment is nearer than outer Segment
    expect(voiceEl.props["voice"]).toBe("inner-host");
  });

  it("Voice in outer Segment gets outer Segment voice (not inner sibling's)", () => {
    const tree = episode({ voice: "episode-host" },
      segment({ voice: "seg1-host" },
        voice({}, "Segment 1 voice"),
      ),
      segment({ voice: "seg2-host" },
        voice({}, "Segment 2 voice"),
      ),
    );
    const resolved = resolveInheritance(tree);
    const seg1 = resolved.children[0] as SoundstageElement;
    const seg2 = resolved.children[1] as SoundstageElement;
    expect((seg1.children[0] as SoundstageElement).props["voice"]).toBe("seg1-host");
    expect((seg2.children[0] as SoundstageElement).props["voice"]).toBe("seg2-host");
  });

  it("inheritance crosses a MusicBed and MusicBed.src does NOT cascade to child Voice", () => {
    // <Episode voice="narrator"><MusicBed src="..."><Voice/></MusicBed></Episode>
    // Voice should inherit voice from Episode (MusicBed is transparent),
    // but Voice must NOT receive MusicBed's src prop.
    const tree = episode({ voice: "narrator" },
      musicBed("music.mp3", {},
        voice({}, "Hello"),
      ),
    );
    const resolved = resolveInheritance(tree);
    const bed = resolved.children[0] as SoundstageElement;
    const voiceEl = bed.children[0] as SoundstageElement;
    expect(voiceEl.props["voice"]).toBe("narrator");
    expect(voiceEl.props["src"]).toBeUndefined();
  });
});

// Structural props do NOT inherit
describe("inheritance — structural props do not cascade", () => {
  it("title on Segment does NOT propagate to descendant Voice", () => {
    const tree = episode({ title: "Episode Title" },
      segment({ title: "Intro", voice: "host" },
        voice({}, "Hello"),
      ),
    );
    const resolved = resolveInheritance(tree);
    const seg = resolved.children[0] as SoundstageElement;
    const voiceEl = seg.children[0] as SoundstageElement;
    // Voice should NOT have a title from Segment
    expect(voiceEl.props["title"]).toBeUndefined();
  });

  it("src on Episode (if set) does NOT propagate to descendant Voice", () => {
    // Episode doesn't have src in schema, but testing that no random structural props cascade
    const tree = jsxs("Episode", {
      title: "EP",
      src: "should-not-cascade.wav",  // not in Episode schema, tests that arbitrary extra props don't cascade
      voice: "narrator",
      children: [voice({}, "Hello")],
    }, undefined);
    const resolved = resolveInheritance(tree);
    const voiceEl = resolved.children[0] as SoundstageElement;
    expect(voiceEl.props["src"]).toBeUndefined();
  });
});

// OD-1 / AC for T5 cache precondition: inherited-vs-inline produce identical effective props
describe("inheritance — effective props are location-independent (T5 cache key precondition)", () => {
  it("Voice inheriting voice from Segment and Voice with explicit voice produce identical effective props object", () => {
    // Tree A: voice is inherited from Segment
    const treeA = episode({},
      segment({ voice: "host", speed: 1.0 },
        voice({}, "Hello world"),
      ),
    );
    // Tree B: voice is explicitly set on Voice
    const treeB = episode({},
      segment({},
        voice({ voice: "host", speed: 1.0 }, "Hello world"),
      ),
    );

    const resolvedA = resolveInheritance(treeA);
    const resolvedB = resolveInheritance(treeB);

    const voiceElA = (resolvedA.children[0] as SoundstageElement).children[0] as SoundstageElement;
    const voiceElB = (resolvedB.children[0] as SoundstageElement).children[0] as SoundstageElement;

    // Full effective props must be equal (catches leaked structural props)
    expect(voiceElA.props).toEqual(voiceElB.props);
  });

  it("provider is also inherited and produces same effective props", () => {
    const treeA = episode({ voice: "narrator", provider: "kokoro" },
      voice({}, "Hello"),
    );
    const treeB = episode({},
      voice({ voice: "narrator", provider: "kokoro" }, "Hello"),
    );

    const resolvedA = resolveInheritance(treeA);
    const resolvedB = resolveInheritance(treeB);

    const voiceElA = resolvedA.children[0] as SoundstageElement;
    const voiceElB = resolvedB.children[0] as SoundstageElement;

    expect(voiceElA.props["voice"]).toBe(voiceElB.props["voice"]);
    expect(voiceElA.props["provider"]).toBe(voiceElB.props["provider"]);
  });
});

// resolveInheritance should be a pure function — same input → same output
describe("inheritance — pure function", () => {
  it("returns a new tree (does not mutate the original)", () => {
    const tree = episode({ voice: "host" },
      voice({}, "Hello"),
    );
    void tree.children[0]; // reference to confirm it exists before mutation check
    resolveInheritance(tree);
    // Original should be unchanged
    const voiceEl = tree.children[0] as SoundstageElement;
    expect(voiceEl.props["voice"]).toBeUndefined();
  });

  it("is synchronous (not a Promise)", () => {
    const tree = episode({}, voice({ voice: "host" }, "text"));
    const result = resolveInheritance(tree);
    expect(result).not.toBeInstanceOf(Promise);
  });
});

// Depth guard
describe("inheritance — depth guard", () => {
  it("throws E_MAX_DEPTH with SoundstageError when tree nesting exceeds MAX_DEPTH", () => {
    // Build a tree 102 levels deep
    let node: SoundstageElement = voice({ voice: "host" }, "leaf");
    for (let i = 0; i < 102; i++) {
      node = segment({}, node);
    }
    const tree = episode({}, node);

    let thrown: unknown;
    try {
      resolveInheritance(tree);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(SoundstageError);
    const err = thrown as SoundstageError;
    expect(err.code).toBe("E_MAX_DEPTH");
    expect(typeof err.path).toBe("string");
    expect(err.path.length).toBeGreaterThan(0);
  });
});
