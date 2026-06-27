// Unit tests for Phase B — Lower to Flat IR.
// All tests use hand-constructed resolved-tree fixtures (no I/O, no TTS).
// Exact sample numbers are asserted per the AC formulas in issue #7.

import { describe, it, expect } from "vitest";
import { phaseB } from "../../src/ir/phase-b.js";
import { SoundstageError } from "../../src/ir/errors.js";
import type { SoundstageElement } from "../../src/jsx-runtime/index.js";
import { SCHEMA_VERSION } from "../../src/schema-version.js";

const SAMPLE_RATE = 48000;

// ---------------------------------------------------------------------------
// Fixture builders — hand-constructed resolved-tree nodes (Phase A output shape)
// ---------------------------------------------------------------------------

function episode(children: SoundstageElement[], opts: { sampleRate?: number; author?: string; artwork?: string } = {}): SoundstageElement {
  return {
    type: "Episode",
    props: {
      title: "Test Episode",
      sampleRate: opts.sampleRate ?? SAMPLE_RATE,
      ...(opts.author !== undefined ? { author: opts.author } : {}),
      ...(opts.artwork !== undefined ? { artwork: opts.artwork } : {}),
    },
    children,
  };
}

function voiceNode(durationSamples: number, voiceUnitId = 0, hash = "abc123"): SoundstageElement {
  return {
    type: "Voice",
    props: {
      voice: "host",
      voiceUnitId,
      chunks: [{ wavPath: `.soundstage/cache/${hash}.wav`, hash, durationSamples, sampleRate: 48000, hit: false, originalText: "some text." }],
    },
    children: ["some text"],
  };
}

function silenceNode(durationSeconds: number): SoundstageElement {
  return {
    type: "Silence",
    props: { duration: durationSeconds },
    children: [],
  };
}

function crossfadeNode(durationSeconds: number): SoundstageElement {
  return {
    type: "Crossfade",
    props: { duration: durationSeconds },
    children: [],
  };
}

function segmentNode(title: string, children: SoundstageElement[]): SoundstageElement {
  return {
    type: "Segment",
    props: { title },
    children,
  };
}

function musicBedNode(children: SoundstageElement[], duck = -12, opts: { fadeIn?: number; fadeOut?: number; loop?: boolean } = {}): SoundstageElement {
  return {
    type: "MusicBed",
    props: {
      src: "bed.mp3",
      duck,
      sourceRef: { kind: "file", path: "/abs/bed.mp3" },
      durationSamples: 96000,
      ...(opts.fadeIn !== undefined ? { fadeIn: opts.fadeIn } : {}),
      ...(opts.fadeOut !== undefined ? { fadeOut: opts.fadeOut } : {}),
      ...(opts.loop !== undefined ? { loop: opts.loop } : {}),
    },
    children,
  };
}

// ---------------------------------------------------------------------------
// AC 1: Two sequential Voice clips — second startSample = first durationSamples
// ---------------------------------------------------------------------------

describe("AC1 — two sequential Voice clips", () => {
  it("second clip startSample === first clip durationSamples", () => {
    const first = voiceNode(100000, 0, "hash0");
    const second = voiceNode(80000, 1, "hash1");
    const tree = episode([first, second]);
    const ir = phaseB(tree);

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips).toHaveLength(2);
    expect(voiceClips[0]!.startSample).toBe(0);
    expect(voiceClips[0]!.durationSamples).toBe(100000);
    expect(voiceClips[1]!.startSample).toBe(100000); // = first.durationSamples
    expect(voiceClips[1]!.durationSamples).toBe(80000);
  });

  it("three sequential clips — each starts after previous ends", () => {
    const a = voiceNode(50000, 0, "ha");
    const b = voiceNode(60000, 1, "hb");
    const c = voiceNode(70000, 2, "hc");
    const tree = episode([a, b, c]);
    const ir = phaseB(tree);

    const clips = ir.clips.filter(cl => cl.trackId === "voice");
    expect(clips[0]!.startSample).toBe(0);
    expect(clips[1]!.startSample).toBe(50000);
    expect(clips[2]!.startSample).toBe(110000); // 50000 + 60000
  });
});

// ---------------------------------------------------------------------------
// AC 2: <Crossfade duration={0.75}> — overlap math (exact formulas)
// ---------------------------------------------------------------------------

describe("AC2 — Crossfade overlap math", () => {
  it("crossfade at 48000: second clip shifts earlier by Math.round(0.75*48000)=36000", () => {
    const overlapSamples = Math.round(0.75 * SAMPLE_RATE); // 36000

    const first = voiceNode(100000, 0, "ha");
    const second = voiceNode(80000, 1, "hb");
    const tree = episode([first, crossfadeNode(0.75), second]);
    const ir = phaseB(tree);

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips).toHaveLength(2);

    expect(voiceClips[0]!.crossfadeIntoNext).toBeDefined();
    expect(voiceClips[0]!.crossfadeIntoNext!.durationSamples).toBe(overlapSamples);
    expect(voiceClips[0]!.crossfadeIntoNext!.curve).toBe("tri");
    expect(voiceClips[1]!.startSample).toBe(100000 - overlapSamples); // 64000
  });

  it("crossfade durationSamples uses IR sampleRate not hardcoded 48000 (44100 test)", () => {
    const sr = 44100;
    const overlapSamples = Math.round(0.75 * sr); // 33075

    const first = voiceNode(100000, 0, "ha");
    const second = voiceNode(80000, 1, "hb");
    const tree = episode([first, crossfadeNode(0.75), second], { sampleRate: sr });
    const ir = phaseB(tree);

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips[0]!.crossfadeIntoNext!.durationSamples).toBe(overlapSamples);
    expect(voiceClips[1]!.startSample).toBe(100000 - overlapSamples);
  });

  it("total timeline shortens by the crossfade overlap: 80000+60000-24000 = 116000", () => {
    // Math.round(0.5 * 48000) = 24000; expected value pinned as a literal
    const first = voiceNode(80000, 0, "ha");
    const second = voiceNode(60000, 1, "hb");
    const tree = episode([first, crossfadeNode(0.5), second]);
    const ir = phaseB(tree);

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    const lastClip = voiceClips[1]!;
    expect(lastClip.startSample + lastClip.durationSamples).toBe(116000); // 80000+60000-24000
  });

  it("crossfade inside a Segment (recursive walkSiblings path)", () => {
    // Exercises the recursive path: Segment → walkSiblings → crossfade logic
    // Math.round(0.5 * 48000) = 24000
    const v1 = voiceNode(80000, 0, "ha");
    const v2 = voiceNode(60000, 1, "hb");
    const tree = episode([segmentNode("Intro", [v1, crossfadeNode(0.5), v2])]);
    const ir = phaseB(tree);

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips[0]!.crossfadeIntoNext!.durationSamples).toBe(24000);
    expect(voiceClips[1]!.startSample).toBe(56000); // 80000 - 24000
    // Chapter endSample covers the shortened span: 56000 + 60000 = 116000
    expect(ir.chapters[0]!.endSample).toBe(116000);
  });
});

// ---------------------------------------------------------------------------
// AC 3: Crossfade overrun → E_CROSSFADE_DURATION
// ---------------------------------------------------------------------------

describe("AC3 — Crossfade overrun throws E_CROSSFADE_DURATION", () => {
  it("crossfade durationSamples > preceding clip durationSamples → SoundstageError with E_CROSSFADE_DURATION", () => {
    const small = voiceNode(1000, 0, "ha"); // 1000 samples
    const second = voiceNode(80000, 1, "hb");
    // Math.round(1.0 * 48000) = 48000 > 1000 → overrun on preceding clip
    const tree = episode([small, crossfadeNode(1.0), second]);

    expect(() => phaseB(tree)).toThrow(
      expect.objectContaining({ code: "E_CROSSFADE_DURATION" }),
    );
    expect(() => phaseB(tree)).toThrow(SoundstageError);
  });

  it("crossfade durationSamples > following clip durationSamples → SoundstageError with E_CROSSFADE_DURATION", () => {
    const first = voiceNode(80000, 0, "ha");
    const small = voiceNode(500, 1, "hb"); // 500 samples
    // Math.round(1.0 * 48000) = 48000 > 500 → overrun on following clip
    const tree = episode([first, crossfadeNode(1.0), small]);

    expect(() => phaseB(tree)).toThrow(
      expect.objectContaining({ code: "E_CROSSFADE_DURATION" }),
    );
    expect(() => phaseB(tree)).toThrow(SoundstageError);
  });

  it("consecutive crossfades [V0, X, V1(short), X, V2] → E_CROSSFADE_DURATION when middle clip shorter than second crossfade", () => {
    // V0=80000, crossfade=0.5s(24000), V1=10000(short), crossfade=0.5s(24000 > 10000), V2=80000
    const v0 = voiceNode(80000, 0, "ha");
    const v1 = voiceNode(10000, 1, "hb"); // 10000 < 24000 — shorter than second crossfade
    const v2 = voiceNode(80000, 2, "hc");
    const tree = episode([v0, crossfadeNode(0.5), v1, crossfadeNode(0.5), v2]);

    expect(() => phaseB(tree)).toThrow(SoundstageError);
    expect(() => phaseB(tree)).toThrow(
      expect.objectContaining({ code: "E_CROSSFADE_DURATION" }),
    );
  });
});

// ---------------------------------------------------------------------------
// AC 4: <Segment title="Intro"> emits a chapters[] entry
// ---------------------------------------------------------------------------

describe("AC4 — Segment emits chapters entry", () => {
  it("startSample === first child's startSample, endSample === lastChild.startSample + lastChild.durationSamples", () => {
    const v1 = voiceNode(100000, 0, "ha");
    const v2 = voiceNode(80000, 1, "hb");
    const tree = episode([segmentNode("Intro", [v1, v2])]);
    const ir = phaseB(tree);

    expect(ir.chapters).toHaveLength(1);
    const ch = ir.chapters[0]!;
    expect(ch.title).toBe("Intro");
    expect(ch.startSample).toBe(0);
    // endSample = lastChild.startSample(100000) + lastChild.durationSamples(80000) = 180000
    expect(ch.endSample).toBe(180000);
  });

  it("formula: endSample === lastChild.startSample + lastChild.durationSamples (three children)", () => {
    const v1 = voiceNode(50000, 0, "ha");
    const v2 = voiceNode(70000, 1, "hb");
    const v3 = voiceNode(30000, 2, "hc");
    const tree = episode([segmentNode("Intro", [v1, v2, v3])]);
    const ir = phaseB(tree);

    // lastChild.startSample = 50000+70000 = 120000; lastChild.durationSamples = 30000
    expect(ir.chapters[0]!.endSample).toBe(150000);
  });

  it("multiple segments emit chapters in tree order", () => {
    const v1 = voiceNode(100000, 0, "ha");
    const v2 = voiceNode(80000, 1, "hb");
    const tree = episode([
      segmentNode("Intro", [v1]),
      segmentNode("Outro", [v2]),
    ]);
    const ir = phaseB(tree);

    expect(ir.chapters).toHaveLength(2);
    expect(ir.chapters[0]!.title).toBe("Intro");
    expect(ir.chapters[0]!.startSample).toBe(0);
    expect(ir.chapters[0]!.endSample).toBe(100000);
    expect(ir.chapters[1]!.title).toBe("Outro");
    expect(ir.chapters[1]!.startSample).toBe(100000);
    expect(ir.chapters[1]!.endSample).toBe(180000);
  });

  it("nested segments: inner appears before outer in chapters[] array, correct positions", () => {
    const v1 = voiceNode(40000, 0, "ha");
    const v2 = voiceNode(60000, 1, "hb");
    const inner = segmentNode("Inner", [v2]);
    const tree = episode([segmentNode("Outer", [v1, inner])]);
    const ir = phaseB(tree);

    expect(ir.chapters).toHaveLength(2);
    const outer = ir.chapters.find(c => c.title === "Outer")!;
    const innerCh = ir.chapters.find(c => c.title === "Inner")!;
    expect(outer.startSample).toBe(0);
    expect(outer.endSample).toBe(100000);
    expect(innerCh.startSample).toBe(40000);
    expect(innerCh.endSample).toBe(100000);
    // Depth-first: Inner is pushed before Outer
    expect(ir.chapters.indexOf(innerCh)).toBeLessThan(ir.chapters.indexOf(outer));
  });
});

// ---------------------------------------------------------------------------
// AC 5: <MusicBed> — bed-0 track, clip spans [firstChild.start, lastChild.end], ducking entry
// ---------------------------------------------------------------------------

describe("AC5 — MusicBed span and ducking entry", () => {
  it("emits a bed-0 track, one bed clip, and one ducking entry with preset:speech-v1", () => {
    const v1 = voiceNode(100000, 0, "ha");
    const v2 = voiceNode(80000, 1, "hb");
    const tree = episode([musicBedNode([v1, v2], -12)]);
    const ir = phaseB(tree);

    expect(ir.tracks.some(t => t.trackId === "bed-0")).toBe(true);

    const bedClips = ir.clips.filter(c => c.trackId === "bed-0");
    expect(bedClips).toHaveLength(1);
    const bedClip = bedClips[0]!;

    // Spans firstChild.startSample=0 to lastChild.startSample+lastChild.durationSamples=180000
    expect(bedClip.startSample).toBe(0);
    expect(bedClip.durationSamples).toBe(180000); // 100000 + 80000

    expect(ir.ducking).toHaveLength(1);
    const duck = ir.ducking[0]!;
    expect(duck.bedTrackId).toBe("bed-0");
    expect(duck.duckUnderTrackId).toBe("voice");
    expect(duck.reductionDb).toBe(-12);
    expect(duck.preset).toBe("speech-v1");
  });

  it("reductionDb === MusicBed.duck prop", () => {
    const v1 = voiceNode(50000, 0, "ha");
    const tree = episode([musicBedNode([v1], -18)]);
    expect(phaseB(tree).ducking[0]!.reductionDb).toBe(-18);
  });

  it("two MusicBeds produce bed-0 and bed-1 tracks in order, with separate ducking entries", () => {
    const v1 = voiceNode(50000, 0, "ha");
    const v2 = voiceNode(50000, 1, "hb");
    const tree = episode([musicBedNode([v1]), musicBedNode([v2])]);
    const ir = phaseB(tree);

    expect(ir.tracks[0]!.trackId).toBe("voice");
    expect(ir.tracks[1]!.trackId).toBe("bed-0");
    expect(ir.tracks[2]!.trackId).toBe("bed-1");
    expect(ir.ducking[0]!.bedTrackId).toBe("bed-0");
    expect(ir.ducking[1]!.bedTrackId).toBe("bed-1");
  });

  it("MusicBed with loop=true sets loop flag on the bed clip, not trim", () => {
    const v1 = voiceNode(50000, 0, "ha");
    const tree = episode([musicBedNode([v1], -12, { loop: true })]);
    const ir = phaseB(tree);

    const bedClip = ir.clips.find(c => c.trackId === "bed-0")!;
    expect(bedClip.loop).toBe(true);
    expect(bedClip.trim).toBeUndefined(); // trim must NOT be used as a loop proxy
  });
});

// ---------------------------------------------------------------------------
// AC 6: <Silence duration={1}> emits a clip with durationSamples === Math.round(1 * sampleRate)
// ---------------------------------------------------------------------------

describe("AC6 — Silence emits clip with formula-based durationSamples", () => {
  it("durationSamples === Math.round(1 * 48000) = 48000", () => {
    const tree = episode([silenceNode(1)]);
    const ir = phaseB(tree);

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips).toHaveLength(1);
    expect(voiceClips[0]!.durationSamples).toBe(48000);
    expect(voiceClips[0]!.sourceRef.kind).toBe("silence");
  });

  it("fractional duration: Math.round(0.5 * 48000) = 24000", () => {
    const tree = episode([silenceNode(0.5)]);
    const ir = phaseB(tree);

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips[0]!.durationSamples).toBe(24000);
    expect(voiceClips[0]!.sourceRef.kind).toBe("silence");
  });

  it("durationSamples uses ir.sampleRate not hardcoded 48000: Math.round(2.5 * 44100) = 110250", () => {
    const tree = episode([silenceNode(2.5)], { sampleRate: 44100 });
    expect(phaseB(tree).clips[0]!.durationSamples).toBe(110250);
  });

  it("Silence followed by Voice: Voice startSample = 48000 (Silence durationSamples)", () => {
    const voice = voiceNode(80000, 0, "ha");
    const tree = episode([silenceNode(1.0), voice]);
    const ir = phaseB(tree);

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips[0]!.durationSamples).toBe(48000);
    expect(voiceClips[1]!.startSample).toBe(48000);
  });
});

// ---------------------------------------------------------------------------
// AC 7: All clip.id values are unique and assigned in tree order
// ---------------------------------------------------------------------------

describe("AC7 — clip id uniqueness and tree-order assignment", () => {
  it("all clip IDs are unique", () => {
    const tree = episode([voiceNode(50000, 0, "ha"), voiceNode(60000, 1, "hb"), voiceNode(70000, 2, "hc")]);
    const ids = phaseB(tree).clips.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("voice clip IDs assigned in tree order: c0, c1", () => {
    const tree = episode([voiceNode(50000, 0, "ha"), voiceNode(60000, 1, "hb")]);
    const voiceClips = phaseB(tree).clips.filter(c => c.trackId === "voice");
    expect(voiceClips[0]!.id).toBe("c0");
    expect(voiceClips[1]!.id).toBe("c1");
  });

  it("IDs are deterministic: same tree always produces same IDs", () => {
    const tree = episode([voiceNode(50000, 0, "ha"), voiceNode(60000, 1, "hb")]);
    expect(phaseB(tree).clips.map(c => c.id)).toEqual(phaseB(tree).clips.map(c => c.id));
  });
});

// ---------------------------------------------------------------------------
// AC 8: schemaVersion present and correct
// ---------------------------------------------------------------------------

describe("AC8 — top-level IR fields", () => {
  it("schemaVersion matches SCHEMA_VERSION constant", () => {
    expect(phaseB(episode([voiceNode(48000, 0, "ha")])).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("sampleRate matches Episode sampleRate prop", () => {
    expect(phaseB(episode([voiceNode(48000, 0, "ha")], { sampleRate: 44100 })).sampleRate).toBe(44100);
  });

  it("channels is 1", () => {
    expect(phaseB(episode([voiceNode(48000, 0, "ha")])).channels).toBe(1);
  });

  it("episode metadata from Episode props", () => {
    const tree: SoundstageElement = {
      type: "Episode",
      props: { title: "My Show", author: "André", artwork: "cover.png", sampleRate: 48000 },
      children: [voiceNode(48000, 0, "ha")],
    };
    const ir = phaseB(tree);
    expect(ir.episode.title).toBe("My Show");
    expect(ir.episode.author).toBe("André");
    expect(ir.episode.artwork).toBe("cover.png");
  });

  it("loudness has EBU R128 defaults: I=-16, TP=-1.5, LRA=11", () => {
    const ir = phaseB(episode([voiceNode(48000, 0, "ha")]));
    expect(ir.loudness.targetI).toBe(-16);
    expect(ir.loudness.targetTP).toBe(-1.5);
    expect(ir.loudness.targetLRA).toBe(11);
  });

  it("voice track is first in tracks[]", () => {
    expect(phaseB(episode([voiceNode(48000, 0, "ha")])).tracks[0]!.trackId).toBe("voice");
  });

  it("render.outputs is an array", () => {
    expect(Array.isArray(phaseB(episode([voiceNode(48000, 0, "ha")])).render.outputs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Segment-crossfade following-clip guard: checks first clip of following Segment
// ---------------------------------------------------------------------------

describe("Segment-crossfade following-clip guard", () => {
  it("throws E_CROSSFADE_DURATION when crossfade > first clip of following Segment (not segment total)", () => {
    // Segment 2 has a short first voice clip (1000 samples) followed by a long clip (200000 samples).
    // Total segment duration >> crossfade, but first clip < crossfade → must throw.
    const short = voiceNode(1000, 1, "short");
    const long = voiceNode(200000, 2, "long");
    const seg2 = segmentNode("Topic", [short, long]);

    const seg1voice = voiceNode(100000, 0, "seg1");
    const seg1 = segmentNode("Intro", [seg1voice]);

    // crossfade = 1.0 * 48000 = 48000 samples > 1000 (first clip of seg2) → E_CROSSFADE_DURATION
    const tree = episode([seg1, crossfadeNode(1.0), seg2]);
    expect(() => phaseB(tree)).toThrow(
      expect.objectContaining({ code: "E_CROSSFADE_DURATION" }),
    );
    expect(() => phaseB(tree)).toThrow(SoundstageError);
  });

  it("valid crossfade between segments: startSample correct, chapters span correctly", () => {
    // Segment 1: one voice clip of 100000 samples
    // Crossfade: 0.5s = 24000 samples at 48kHz
    // Segment 2: first voice clip 48000 samples (> crossfade), second 60000 samples
    const v1 = voiceNode(100000, 0, "s1v1");
    const v2 = voiceNode(48000, 1, "s2v1"); // first clip of seg2
    const v3 = voiceNode(60000, 2, "s2v2");
    const seg1 = segmentNode("Intro", [v1]);
    const seg2 = segmentNode("Main", [v2, v3]);

    const overlapSamples = Math.round(0.5 * SAMPLE_RATE); // 24000
    const tree = episode([seg1, crossfadeNode(0.5), seg2]);
    const ir = phaseB(tree);

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips).toHaveLength(3);

    // seg1 voice starts at 0
    expect(voiceClips[0]!.startSample).toBe(0);
    expect(voiceClips[0]!.durationSamples).toBe(100000);

    // seg2 first voice starts at cursor - overlap: 100000 - 24000 = 76000
    expect(voiceClips[1]!.startSample).toBe(100000 - overlapSamples); // 76000
    expect(voiceClips[1]!.durationSamples).toBe(48000);

    // seg2 second voice starts after first: 76000 + 48000 = 124000
    expect(voiceClips[2]!.startSample).toBe(76000 + 48000); // 124000

    // Chapter spans
    const intro = ir.chapters.find(c => c.title === "Intro")!;
    const main = ir.chapters.find(c => c.title === "Main")!;
    expect(intro).toBeDefined();
    expect(main).toBeDefined();

    expect(intro.startSample).toBe(0);
    expect(intro.endSample).toBe(100000); // lastClip.start + lastClip.dur = 0 + 100000

    expect(main.startSample).toBe(76000);
    expect(main.endSample).toBe(124000 + 60000); // 184000
  });

  it("multi-clip Seg → Crossfade → multi-clip Seg: crossfadeIntoNext on LAST clip of Seg1, startSample of FIRST clip of Seg2 shifted", () => {
    // Seg1 = [V1(80000), V2(70000)], Crossfade(0.5s=24000), Seg2 = [V3(48000), V4(60000)]
    // Crossfade must be set on V2 (last of Seg1), not V1.
    // Seg2's first clip V3 (48000 > 24000) must be the boundary → no throw.
    // V3.startSample = (80000 + 70000) - 24000 = 126000
    const v1 = voiceNode(80000, 0, "s1v1");
    const v2 = voiceNode(70000, 1, "s1v2"); // last clip of Seg1 — crossfadeIntoNext must land here
    const v3 = voiceNode(48000, 2, "s2v1"); // first clip of Seg2 — boundary for guard
    const v4 = voiceNode(60000, 3, "s2v2");
    const seg1 = segmentNode("Seg1", [v1, v2]);
    const seg2 = segmentNode("Seg2", [v3, v4]);

    const overlapSamples = Math.round(0.5 * SAMPLE_RATE); // 24000
    const tree = episode([seg1, crossfadeNode(0.5), seg2]);
    const ir = phaseB(tree);

    const voiceClips = ir.clips.filter(c => c.trackId === "voice");
    expect(voiceClips).toHaveLength(4);

    // V1 at 0, V2 at 80000
    expect(voiceClips[0]!.startSample).toBe(0);
    expect(voiceClips[1]!.startSample).toBe(80000);

    // crossfadeIntoNext must be on V2 (voiceClips[1]), NOT V1
    expect(voiceClips[0]!.crossfadeIntoNext).toBeUndefined();
    expect(voiceClips[1]!.crossfadeIntoNext).toBeDefined();
    expect(voiceClips[1]!.crossfadeIntoNext!.durationSamples).toBe(overlapSamples);

    // V3 starts at (80000+70000) - 24000 = 126000
    expect(voiceClips[2]!.startSample).toBe(150000 - overlapSamples); // 126000
    expect(voiceClips[3]!.startSample).toBe(126000 + 48000); // 174000

    // Chapter spans
    const ch1 = ir.chapters.find(c => c.title === "Seg1")!;
    const ch2 = ir.chapters.find(c => c.title === "Seg2")!;
    expect(ch1.endSample).toBe(80000 + 70000); // 150000 (last clip of Seg1)
    expect(ch2.startSample).toBe(126000); // first clip of Seg2
    expect(ch2.endSample).toBe(174000 + 60000); // 234000
  });
});

// ---------------------------------------------------------------------------
// AC 9 (snapshot): compound fixture covering all Phase B features
// Includes: sequential clips, Segment chapter, Crossfade, MusicBed, Silence.
// Removing any feature from the implementation will break this snapshot.
// ---------------------------------------------------------------------------

describe("AC9 — snapshot test", () => {
  it("compound fixture (seq + crossfade + segment + musicbed + silence) produces exact IR snapshot", () => {
    const v0 = voiceNode(211200, 0, "deadbeef01"); // inside Intro segment
    const v1 = voiceNode(96000, 1, "deadbeef02");  // crossfade into v2
    const v2 = voiceNode(72000, 2, "deadbeef03");  // Math.round(0.5*48000)=24000 overlap
    const sil = silenceNode(1.0);                  // 48000 samples
    const bed = musicBedNode([sil], -12);           // bed wrapping the silence

    const tree: SoundstageElement = {
      type: "Episode",
      props: { title: "Grafex weekly #12", author: "André", sampleRate: 48000 },
      children: [
        segmentNode("Intro", [v0]),
        v1,
        crossfadeNode(0.5),
        v2,
        bed,
      ],
    };
    expect(phaseB(tree)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// AC 10 (pure function): same input → same output, no side effects
// ---------------------------------------------------------------------------

describe("AC10 — pure function", () => {
  it("same input always produces identical output", () => {
    const tree = episode([voiceNode(100000, 0, "ha"), voiceNode(80000, 1, "hb")]);
    expect(phaseB(tree)).toEqual(phaseB(tree));
  });
});

// ---------------------------------------------------------------------------
// Security fix: negative Crossfade duration → E_INVALID_PROP
// ---------------------------------------------------------------------------

describe("Security — negative or invalid Crossfade duration", () => {
  it("negative duration throws SoundstageError with E_CROSSFADE_DURATION (not silent IR corruption)", () => {
    const first = voiceNode(80000, 0, "ha");
    const second = voiceNode(60000, 1, "hb");
    const tree = episode([first, { type: "Crossfade", props: { duration: -1 }, children: [] }, second]);

    expect(() => phaseB(tree)).toThrow(SoundstageError);
    expect(() => phaseB(tree)).toThrow(
      expect.objectContaining({ code: "E_CROSSFADE_DURATION" }),
    );
  });

  it("zero duration throws E_CROSSFADE_DURATION", () => {
    const first = voiceNode(80000, 0, "ha");
    const second = voiceNode(60000, 1, "hb");
    const tree = episode([first, { type: "Crossfade", props: { duration: 0 }, children: [] }, second]);

    expect(() => phaseB(tree)).toThrow(
      expect.objectContaining({ code: "E_CROSSFADE_DURATION" }),
    );
  });

  it("NaN duration throws E_CROSSFADE_DURATION", () => {
    const first = voiceNode(80000, 0, "ha");
    const second = voiceNode(60000, 1, "hb");
    const tree = episode([first, { type: "Crossfade", props: { duration: NaN }, children: [] }, second]);

    expect(() => phaseB(tree)).toThrow(SoundstageError);
    expect(() => phaseB(tree)).toThrow(
      expect.objectContaining({ code: "E_CROSSFADE_DURATION" }),
    );
  });

  it("Infinity duration throws E_CROSSFADE_DURATION", () => {
    const first = voiceNode(80000, 0, "ha");
    const second = voiceNode(60000, 1, "hb");
    const tree = episode([first, { type: "Crossfade", props: { duration: Infinity }, children: [] }, second]);

    expect(() => phaseB(tree)).toThrow(SoundstageError);
    expect(() => phaseB(tree)).toThrow(
      expect.objectContaining({ code: "E_CROSSFADE_DURATION" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Depth guard: deeply nested tree throws E_MAX_DEPTH
// ---------------------------------------------------------------------------

describe("Depth guard — E_MAX_DEPTH", () => {
  it("a tree nested deeper than MAX_DEPTH (100) throws E_MAX_DEPTH", () => {
    // Build a chain of 102 nested Segments — triggers the guard
    let inner: SoundstageElement = voiceNode(48000, 0, "ha");
    for (let i = 0; i < 102; i++) {
      inner = segmentNode(`s${i}`, [inner]);
    }
    const tree = episode([inner]);

    expect(() => phaseB(tree)).toThrow(SoundstageError);
    expect(() => phaseB(tree)).toThrow(
      expect.objectContaining({ code: "E_MAX_DEPTH" }),
    );
  });
});
