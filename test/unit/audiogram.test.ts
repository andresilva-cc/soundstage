// Unit tests for src/compiler/audiogram.ts — buildAudiogramFilter pure helper
// + generateAudiogram error surfacing.
//
// buildAudiogramFilter tests are hermetic (no ffmpeg, no I/O).
// generateAudiogram error test mocks node:child_process + node:fs/promises.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

import type * as NodeChildProcess from "node:child_process";
import type * as NodeFsPromises from "node:fs/promises";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, execFile: mockExecFile };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock — hoisted by vitest)
// ---------------------------------------------------------------------------

import { buildAudiogramFilter, generateAudiogram } from "../../src/compiler/audiogram.js";
import type { IR } from "../../src/ir/phase-b.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SR = 48000;

function makeIR(overrides: Partial<{ title: string; chapters: IR["chapters"]; clips: IR["clips"] }> = {}): IR {
  const clips: IR["clips"] = overrides.clips ?? [
    {
      id: "c0",
      sourceRef: { kind: "cache", path: "/fake/cache/abc.wav" },
      trackId: "voice",
      startSample: 0,
      durationSamples: 48000,
      gainDb: 0,
    },
  ];
  return {
    schemaVersion: 4,
    sampleRate: SR,
    channels: 1,
    episode: { title: overrides.title ?? "Test Episode" },
    tracks: [{ trackId: "voice" }],
    clips,
    ducking: [],
    chapters: overrides.chapters ?? [{ title: "Intro", startSample: 0, endSample: 48000 }],
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav", "mp3"] },
  };
}

// ---------------------------------------------------------------------------
// buildAudiogramFilter — aspect dimensions
// ---------------------------------------------------------------------------

describe("buildAudiogramFilter — aspect dimensions", () => {
  it("default (undefined) produces s=1080x1080", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    expect(script).toContain("s=1080x1080");
  });

  it("aspect 'square' produces s=1080x1080", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", { aspect: "square" });
    expect(script).toContain("s=1080x1080");
  });

  it("aspect 'landscape' produces s=1920x1080", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", { aspect: "landscape" });
    expect(script).toContain("s=1920x1080");
  });

  it("aspect 'vertical' produces s=1080x1920", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", { aspect: "vertical" });
    expect(script).toContain("s=1080x1920");
  });
});

// ---------------------------------------------------------------------------
// buildAudiogramFilter — required filter components
// ---------------------------------------------------------------------------

describe("buildAudiogramFilter — required filter components", () => {
  it("contains a color=c= background source", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    expect(script).toMatch(/color=c=.*\[bg\]/);
  });

  it("contains a showwaves filter applied to the audio input [0:a]", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    expect(script).toMatch(/\[0:a\].*showwaves/);
  });

  it("contains a drawtext filter with episode title", () => {
    const ir = makeIR({ title: "My Podcast" });
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    expect(script).toContain("drawtext=");
    expect(script).toContain("My Podcast");
  });

  it("every drawtext filter contains a fontfile= parameter", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    // Find all drawtext occurrences and verify each has fontfile=
    const drawtextMatches = script.split(";").filter((s) => s.includes("drawtext="));
    expect(drawtextMatches.length).toBeGreaterThan(0);
    for (const seg of drawtextMatches) {
      expect(seg).toContain("fontfile=");
    }
  });

  it("fontfile= path is single-quoted and absolute", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    // fontfile='<abs path>' — single-quoted, starts with '/ (quote then /)
    expect(script).toMatch(/fontfile='\/[^']+'/);
  });
});

// ---------------------------------------------------------------------------
// buildAudiogramFilter — drawtext escaping (adversarial title)
// ---------------------------------------------------------------------------

describe("buildAudiogramFilter — drawtext title escaping", () => {
  it("apostrophe in title is escaped as '\\''", () => {
    const ir = makeIR({ title: "It's a test" });
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    // '\'' is the ffmpeg drawtext escape for a single quote
    expect(script).toContain("'\\''");
    // Raw unescaped apostrophe inside the text value should not appear
    // (The text value is wrapped in single quotes so an unescaped ' would break parsing)
    const textMatch = script.match(/text='((?:[^'\\]|\\.|'\\'')*)'/);
    // If the match is null the escaping is wrong — the text field can't be parsed
    expect(textMatch).not.toBeNull();
  });

  it("colon in title is escaped as \\:", () => {
    const ir = makeIR({ title: "Time: 10:00" });
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    expect(script).toContain("\\:");
  });

  it("backslash in title is doubled to \\\\", () => {
    const ir = makeIR({ title: "path\\to\\file" });
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    expect(script).toContain("\\\\");
  });

  it("adversarial title escapes apostrophe, colon, and backslash", () => {
    // Title: "It's a test: run\" (one apostrophe, one colon, one backslash)
    const ir = makeIR({ title: "It's a test: run\\" });
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    expect(script).toContain("'\\''");   // escaped apostrophe
    expect(script).toContain("\\:");     // escaped colon
    expect(script).toContain("\\\\");   // escaped backslash
  });

  it("percent in title is doubled to %% (prevents drawtext variable expansion)", () => {
    // drawtext expands %{pts}, %{localtime:...}, etc. — a literal % must be doubled.
    const ir = makeIR({ title: "100% done — %{pts} test" });
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    // The text field should contain the doubled form %%
    expect(script).toContain("%%");
    // The original %{pts} must appear as %%{pts} (both % doubled)
    expect(script).toContain("%%{pts}");
    // "100%" must appear as "100%%" (no bare single-% in the output text)
    expect(script).toContain("100%%");
  });
});

// ---------------------------------------------------------------------------
// buildAudiogramFilter — chapter ticks
// ---------------------------------------------------------------------------

describe("buildAudiogramFilter — chapter ticks", () => {
  it("no drawbox when ir.chapters.length === 0", () => {
    const ir = makeIR({ chapters: [] });
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    expect(script).not.toContain("drawbox");
  });

  it("drawbox present when ir.chapters.length > 0", () => {
    const ir = makeIR({ chapters: [{ title: "Intro", startSample: 0, endSample: 48000 }] });
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    expect(script).toContain("drawbox");
  });

  it("chapter tick X at midpoint of episode equals Math.round(W / 2)", () => {
    // Episode: 48000 samples total; chapter at startSample=24000 (midpoint)
    const clips: IR["clips"] = [
      {
        id: "c0",
        sourceRef: { kind: "cache", path: "/fake/cache/abc.wav" },
        trackId: "voice",
        startSample: 0,
        durationSamples: 48000,
        gainDb: 0,
      },
    ];
    const chapters: IR["chapters"] = [
      { title: "A", startSample: 0, endSample: 24000 },
      { title: "B", startSample: 24000, endSample: 48000 },
    ];
    const ir = makeIR({ clips, chapters });
    const script = buildAudiogramFilter(ir, "ep.mp3", { aspect: "square" }); // W=1080
    // tickX for chapter "B" at startSample=24000: Math.round(24000/48000*1080) = Math.round(540) = 540
    expect(script).toContain("x=540:");
  });

  it("two chapters produce two drawbox lines", () => {
    const ir = makeIR({
      chapters: [
        { title: "Intro", startSample: 0, endSample: 24000 },
        { title: "Outro", startSample: 24000, endSample: 48000 },
      ],
    });
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    const drawboxCount = (script.match(/drawbox/g) ?? []).length;
    expect(drawboxCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildAudiogramFilter — logo overlay
// ---------------------------------------------------------------------------

describe("buildAudiogramFilter — logo overlay", () => {
  it("no movie= filter when opts.logoPath is undefined", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    expect(script).not.toContain("movie=");
  });

  it("movie='<logoPath>' present (single-quoted) when opts.logoPath is set", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", { logoPath: "/path/to/logo.png" });
    expect(script).toContain("movie='/path/to/logo.png'");
  });

  it("logo overlay filter present when opts.logoPath is set", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", { logoPath: "/path/to/logo.png" });
    expect(script).toContain("overlay");
    expect(script).toContain("[out_v_final]");
  });

  it("logo path with single quote is escaped as '\\'\\''", () => {
    const ir = makeIR();
    const script = buildAudiogramFilter(ir, "ep.mp3", { logoPath: "/path/with'quote/logo.png" });
    // The single quote inside the path must be escaped so the filter-option value is valid
    expect(script).toContain("'\\''");
  });

  it("output label is [out_v] when no logo", () => {
    const ir = makeIR({ chapters: [] });
    const script = buildAudiogramFilter(ir, "ep.mp3", {});
    expect(script).toContain("[out_v]");
    expect(script).not.toContain("[out_v_final]");
  });
});

// ---------------------------------------------------------------------------
// buildAudiogramFilter — accentColor validation
// ---------------------------------------------------------------------------

describe("buildAudiogramFilter — accentColor validation", () => {
  it("throws on invalid color string (injection attempt with colon)", () => {
    const ir = makeIR();
    expect(() =>
      buildAudiogramFilter(ir, "ep.mp3", { accentColor: "#fff:bad" }),
    ).toThrow("invalid accentColor");
  });

  it("throws on invalid color with semicolon (filter chain injection)", () => {
    const ir = makeIR();
    expect(() =>
      buildAudiogramFilter(ir, "ep.mp3", { accentColor: "red;movie=/evil" }),
    ).toThrow("invalid accentColor");
  });

  it("accepts a valid 6-digit hex with #", () => {
    const ir = makeIR();
    expect(() =>
      buildAudiogramFilter(ir, "ep.mp3", { accentColor: "#e11d48" }),
    ).not.toThrow();
  });

  it("accepts a valid 6-digit hex without #", () => {
    const ir = makeIR();
    expect(() =>
      buildAudiogramFilter(ir, "ep.mp3", { accentColor: "e11d48" }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// generateAudiogram — error surfacing
// ---------------------------------------------------------------------------

describe("generateAudiogram — error surfacing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws Error starting with 'audiogram generation failed:' when ffmpeg exits non-zero", async () => {
    // Mock execFile to simulate ffmpeg failure
    mockExecFile.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        const err = Object.assign(new Error("ffmpeg process error"), {
          stderr: "Error: codec not found",
          code: 1,
        });
        cb(err);
      },
    );

    const ir = makeIR();
    await expect(
      generateAudiogram(ir, "/fake/episode.mp3", {}, "/fake/out"),
    ).rejects.toThrow("audiogram generation failed:");
  });
});
