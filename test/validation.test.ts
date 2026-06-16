import { describe, it, expect } from "vitest";
import { jsx, jsxs } from "../src/jsx-runtime/index.ts";
import type { SoundstageElement } from "../src/jsx-runtime/index.ts";
import { validateTree } from "../src/ir/validate.ts";
import { SoundstageError } from "../src/ir/errors.ts";

// Helper to build element trees without full JSX transform in tests
function episode(props: Record<string, unknown>, ...children: SoundstageElement[]): SoundstageElement {
  return jsxs("Episode", { title: "Test Episode", ...props, children }, undefined);
}

function segment(props: Record<string, unknown>, ...children: SoundstageElement[]): SoundstageElement {
  return jsxs("Segment", { ...props, children }, undefined);
}

function voice(props: Record<string, unknown>, ...textChildren: string[]): SoundstageElement {
  return jsxs("Voice", { ...props, children: textChildren }, undefined);
}

function clip(src: string, props: Record<string, unknown> = {}): SoundstageElement {
  return jsx("Clip", { src, ...props }, undefined);
}

function musicBed(src: string, props: Record<string, unknown> = {}, ...children: SoundstageElement[]): SoundstageElement {
  return jsxs("MusicBed", { src, ...props, children }, undefined);
}

function silence(duration: number): SoundstageElement {
  return jsx("Silence", { duration }, undefined);
}

function crossfade(duration = 0.75): SoundstageElement {
  return jsx("Crossfade", { duration }, undefined);
}

// AC1 — Missing required `voice` prop on <Voice> throws E_MISSING_PROP with path context
describe("validation — missing required props", () => {
  it("throws E_MISSING_PROP when <Voice> is missing the required voice prop", () => {
    const tree = episode({},
      segment({},
        voice({}, "Hello world"),  // no voice prop
      ),
    );
    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    expect((thrown as SoundstageError).code).toBe("E_MISSING_PROP");
  });

  it("includes path context in E_MISSING_PROP error — error.path contains ancestor chain", () => {
    const tree = episode({},
      segment({ title: "Intro" },
        voice({}, "Hello world"),
      ),
    );
    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    const err = thrown as SoundstageError;
    expect(err.code).toBe("E_MISSING_PROP");
    // path must include the ancestor chain: Episode → Segment → Voice
    expect(err.path).toMatch(/Episode/);
    expect(err.path).toMatch(/Segment/);
    expect(err.path).toMatch(/Voice/);
  });

  it("throws E_MISSING_PROP when <Clip> is missing the required src prop", () => {
    const tree = episode({},
      segment({},
        jsx("Clip", {}, undefined),  // no src
      ),
    );
    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    expect((thrown as SoundstageError).code).toBe("E_MISSING_PROP");
  });

  it("throws E_MISSING_PROP when <MusicBed> is missing the required src prop", () => {
    const tree = episode({},
      jsxs("MusicBed", { children: [voice({ voice: "host" }, "text")] }, undefined),
    );
    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    expect((thrown as SoundstageError).code).toBe("E_MISSING_PROP");
  });

  it("throws E_MISSING_PROP when <Silence> is missing the required duration prop", () => {
    const tree = episode({},
      segment({},
        jsx("Silence", {}, undefined),
      ),
    );
    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    expect((thrown as SoundstageError).code).toBe("E_MISSING_PROP");
  });

  it("throws E_MISSING_PROP when <Episode> is missing the required title prop", () => {
    const tree = jsx("Episode", {}, undefined) as SoundstageElement;
    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    expect((thrown as SoundstageError).code).toBe("E_MISSING_PROP");
  });
});

// AC4 — <Crossfade> with no preceding sibling throws E_CROSSFADE_BOUNDARY
describe("validation — crossfade boundary", () => {
  it("throws E_CROSSFADE_BOUNDARY when <Crossfade> has no preceding sibling", () => {
    const tree = episode({},
      segment({},
        crossfade(),
        voice({ voice: "host" }, "Hello"),
      ),
    );
    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    expect((thrown as SoundstageError).code).toBe("E_CROSSFADE_BOUNDARY");
  });

  // AC5 — <Crossfade> with no following sibling throws E_CROSSFADE_BOUNDARY
  it("throws E_CROSSFADE_BOUNDARY when <Crossfade> has no following sibling", () => {
    const tree = episode({},
      segment({},
        voice({ voice: "host" }, "Hello"),
        crossfade(),
      ),
    );
    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    expect((thrown as SoundstageError).code).toBe("E_CROSSFADE_BOUNDARY");
  });

  it("does NOT throw at all when <Crossfade> is properly between two voices", () => {
    const tree = episode({},
      segment({},
        voice({ voice: "host" }, "Hello"),
        crossfade(),
        voice({ voice: "host" }, "World"),
      ),
    );
    expect(() => validateTree(tree)).not.toThrow();
  });

  it("allows <Crossfade> between two <Segment>s (Segment is an audio-producing sibling)", () => {
    // <Crossfade> between two <Segment>s is valid: the crossfade blends the last
    // clip of the first Segment with the first clip of the second Segment.
    const tree = episode({},
      segment({ title: "A" },
        voice({ voice: "host" }, "One"),
      ),
      crossfade(),
      segment({ title: "B" },
        voice({ voice: "host" }, "Two"),
      ),
    );
    expect(() => validateTree(tree)).not.toThrow();
  });

  it("throws E_CROSSFADE_BOUNDARY when neighbor is an Episode (not an audio sibling)", () => {
    // Direct children of Episode: Episode-level crossfade with Episode neighbors
    // Build artificially: a fake parent with Episode children
    const inner = jsxs("Episode", {
      title: "inner",
      children: [
        episode({ title: "A" }),
        crossfade(),
        episode({ title: "B" }),
      ],
    }, undefined);
    // We only need the crossfade-boundary check; wrap in a container Episode
    const tree = jsxs("Episode", {
      title: "root",
      children: [
        episode({ title: "A" }),
        crossfade(),
        episode({ title: "B" }),
      ],
    }, undefined);
    void inner;
    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    expect((thrown as SoundstageError).code).toBe("E_CROSSFADE_BOUNDARY");
  });
});

// AC6 — A src path that does not exist on disk throws E_SRC_NOT_FOUND
describe("validation — src file existence", () => {
  it("throws E_SRC_NOT_FOUND when <Clip src> path does not exist", () => {
    const tree = episode({},
      segment({},
        clip("/nonexistent/path/audio.wav"),
      ),
    );
    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    expect((thrown as SoundstageError).code).toBe("E_SRC_NOT_FOUND");
  });

  it("throws E_SRC_NOT_FOUND when <MusicBed src> path does not exist", () => {
    const tree = episode({},
      musicBed("/nonexistent/bed.mp3", {}, voice({ voice: "host" }, "text")),
    );
    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    expect((thrown as SoundstageError).code).toBe("E_SRC_NOT_FOUND");
  });
});

// AC7 — A valid episode tree passes validation and returns a typed resolved tree
describe("validation — valid tree passes", () => {
  it("returns the resolved tree when all props are valid (no src checks needed for Voice)", () => {
    const tree = episode({ title: "My Episode" },
      segment({ title: "Intro" },
        voice({ voice: "host" }, "Welcome to the show!"),
      ),
    );
    // Should not throw — all required props present
    const result = validateTree(tree);
    expect(result).toBeDefined();
    expect(result.type).toBe("Episode");
  });

  it("validates a tree with crossfade between two voices", () => {
    const tree = episode({ title: "My Episode" },
      segment({ title: "Main" },
        voice({ voice: "host" }, "First part"),
        crossfade(0.5),
        voice({ voice: "host" }, "Second part"),
      ),
    );
    expect(() => validateTree(tree)).not.toThrow();
  });

  it("validates silence with required duration prop", () => {
    const tree = episode({ title: "My Episode" },
      segment({},
        voice({ voice: "host" }, "Hello"),
        silence(1),
        voice({ voice: "host" }, "World"),
      ),
    );
    expect(() => validateTree(tree)).not.toThrow();
  });
});

// validateTree is the single entry point — it resolves and validates
describe("validation — entry point contract", () => {
  it("is synchronous (not a Promise)", () => {
    const tree = episode({},
      segment({},
        voice({ voice: "host" }, "Hello"),
      ),
    );
    const result = validateTree(tree);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("returns the resolved tree — Voice has effective props after inheritance", () => {
    // Voice with no explicit voice prop inherits from Segment
    const tree = episode({},
      segment({ voice: "narrator" },
        voice({}, "Hello"),
      ),
    );
    const resolved = validateTree(tree);
    const seg = resolved.children[0] as SoundstageElement;
    const voiceEl = seg.children[0] as SoundstageElement;
    // The returned tree is resolved, so Voice has the inherited voice
    expect(voiceEl.props["voice"]).toBe("narrator");
  });

  it("is idempotent — validateTree(validateTree(t)) yields a structurally equal tree", () => {
    const tree = episode({},
      segment({ voice: "narrator", speed: 1.0 },
        voice({}, "Hello"),
      ),
    );
    const once = validateTree(tree);
    const twice = validateTree(once);
    expect(twice).toEqual(once);
  });
});

// Depth guard in validateTree
describe("validation — depth guard", () => {
  it("throws E_MAX_DEPTH SoundstageError when tree nesting exceeds MAX_DEPTH", () => {
    let node: SoundstageElement = voice({ voice: "host" }, "leaf");
    for (let i = 0; i < 102; i++) {
      node = segment({}, node);
    }
    const tree = episode({}, node);

    let thrown: unknown;
    try { validateTree(tree); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SoundstageError);
    expect((thrown as SoundstageError).code).toBe("E_MAX_DEPTH");
    expect(typeof (thrown as SoundstageError).path).toBe("string");
  });
});
