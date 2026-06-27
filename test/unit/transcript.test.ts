// Unit tests for src/compiler/transcript.ts (Task 1 — Transcript / Subtitle Export).
// All tests are pure — no fs, no ffmpeg, no network.

import { describe, it, expect } from "vitest";
import {
  extractVoiceTexts,
  generateTranscriptCues,
  samplesToTimestamp,
  formatSrt,
  formatVtt,
  formatTxt,
  type TranscriptCue,
} from "../../src/compiler/transcript.js";
import { findChapterIndex } from "../../src/compiler/chapters.js";
import type { SoundstageElement } from "../../src/jsx-runtime/index.js";
import type { IR, ClipIR, ChapterIR } from "../../src/ir/phase-b.js";
import type { ChunkResult } from "../../src/ir/phase-a.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SR = 48000;

function makeIR(clips: ClipIR[], chapters: ChapterIR[] = []): IR {
  return {
    schemaVersion: 4,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Test Episode" },
    tracks: [{ trackId: "voice" }],
    clips,
    ducking: [],
    chapters,
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav", "mp3"] },
  };
}

function makeVoiceClip(
  id: string,
  startSample: number,
  durationSamples: number,
  voiceUnitId: number,
): ClipIR {
  return {
    id,
    sourceRef: { kind: "cache", path: `.soundstage/cache/${id}.wav`, hash: id, voiceUnitId },
    trackId: "voice",
    startSample,
    durationSamples,
    gainDb: 0,
  };
}

function makeFileClip(id: string, startSample: number, durationSamples: number): ClipIR {
  return {
    id,
    sourceRef: { kind: "file", path: `/clips/${id}.wav` },
    trackId: "voice",
    startSample,
    durationSamples,
    gainDb: 0,
  };
}

function makeSilenceClip(id: string, startSample: number, durationSamples: number): ClipIR {
  return {
    id,
    sourceRef: { kind: "silence" },
    trackId: "voice",
    startSample,
    durationSamples,
    gainDb: 0,
  };
}

function makeChunkResult(text: string, durationSamples: number, hash = "h"): ChunkResult {
  return {
    wavPath: `.soundstage/cache/${hash}.wav`,
    durationSamples,
    sampleRate: 24000,
    hash,
    hit: false,
    originalText: text,
  };
}

function makeVoiceNode(voiceUnitId: number, chunks: ChunkResult[]): SoundstageElement {
  return {
    type: "Voice",
    props: { voice: "host", voiceUnitId, chunks },
    children: [chunks.map(c => c.originalText).join(" ")],
  };
}

function makeEpisode(children: SoundstageElement[]): SoundstageElement {
  return {
    type: "Episode",
    props: { title: "Test", sampleRate: SR },
    children,
  };
}

// ---------------------------------------------------------------------------
// extractVoiceTexts
// ---------------------------------------------------------------------------

describe("extractVoiceTexts", () => {
  it("returns empty map for episode with no Voice nodes", () => {
    const tree = makeEpisode([]);
    const map = extractVoiceTexts(tree);
    expect(map.size).toBe(0);
  });

  it("returns one entry per Voice node with correct voiceUnitId and originalTexts", () => {
    const v0 = makeVoiceNode(0, [
      makeChunkResult("Hello world.", 10000, "h0a"),
      makeChunkResult("Second sentence.", 15000, "h0b"),
    ]);
    const v1 = makeVoiceNode(1, [
      makeChunkResult("Goodbye.", 8000, "h1a"),
      makeChunkResult("See you.", 9000, "h1b"),
      makeChunkResult("Later.", 7000, "h1c"),
    ]);
    const tree = makeEpisode([v0, v1]);
    const map = extractVoiceTexts(tree);

    expect(map.size).toBe(2);
    expect(map.get(0)).toEqual(["Hello world.", "Second sentence."]);
    expect(map.get(1)).toEqual(["Goodbye.", "See you.", "Later."]);
  });

  it("walks nested nodes (Voice inside Segment)", () => {
    const v0 = makeVoiceNode(0, [makeChunkResult("Intro text.", 10000)]);
    const segment: SoundstageElement = {
      type: "Segment",
      props: { title: "Intro" },
      children: [v0],
    };
    const tree = makeEpisode([segment]);
    const map = extractVoiceTexts(tree);
    expect(map.get(0)).toEqual(["Intro text."]);
  });

  it("preserves internal whitespace in originalText (double-space)", () => {
    // The key AC: double spaces survive in originalText (not in cache key normalization)
    const v0 = makeVoiceNode(0, [makeChunkResult("Hello   world.", 10000)]);
    const tree = makeEpisode([v0]);
    const map = extractVoiceTexts(tree);
    expect(map.get(0)![0]).toBe("Hello   world.");
  });
});

// ---------------------------------------------------------------------------
// generateTranscriptCues
// ---------------------------------------------------------------------------

describe("generateTranscriptCues", () => {
  it("produces one cue per voice cache clip", () => {
    const clips = [
      makeVoiceClip("c0", 0, 10000, 0),
      makeVoiceClip("c1", 10000, 20000, 0),
      makeVoiceClip("c2", 30000, 15000, 0),
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([[0, ["Sentence one.", "Sentence two.", "Sentence three."]]]);
    const cues = generateTranscriptCues(ir, voiceTexts);
    expect(cues).toHaveLength(3);
  });

  it("cue.startSample === clip.startSample for each cue", () => {
    const clips = [
      makeVoiceClip("c0", 0, 10000, 0),
      makeVoiceClip("c1", 10000, 20000, 0),
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([[0, ["A.", "B."]]]);
    const cues = generateTranscriptCues(ir, voiceTexts);
    expect(cues[0]!.startSample).toBe(0);
    expect(cues[1]!.startSample).toBe(10000);
  });

  it("cue.endSample === clip.startSample + clip.durationSamples (no crossfade)", () => {
    const clips = [
      makeVoiceClip("c0", 0, 10000, 0),
      makeVoiceClip("c1", 10000, 20000, 0),
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([[0, ["A.", "B."]]]);
    const cues = generateTranscriptCues(ir, voiceTexts);
    expect(cues[0]!.endSample).toBe(10000);
    expect(cues[1]!.endSample).toBe(30000);
  });

  it("crossfade clamping: earlier cue.endSample clamped to next cue.startSample", () => {
    // Simulate crossfade: clip[0] ends at 12000 but clip[1] starts at 8000 (overlap of 4000)
    const clips = [
      makeVoiceClip("c0", 0, 12000, 0),  // endSample = 12000
      makeVoiceClip("c1", 8000, 20000, 0),  // startSample = 8000 (crossfade overlap)
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([[0, ["First.", "Second."]]]);
    const cues = generateTranscriptCues(ir, voiceTexts);
    // cue[0].endSample should be clamped to cue[1].startSample = 8000
    expect(cues[0]!.endSample).toBe(8000);
    expect(cues[1]!.startSample).toBe(8000);
  });

  it("crossfade clamp is no-op when endSample <= nextStart (silence gap)", () => {
    const clips = [
      makeVoiceClip("c0", 0, 8000, 0),    // endSample = 8000
      makeVoiceClip("c1", 10000, 5000, 0), // startSample = 10000 (gap)
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([[0, ["A.", "B."]]]);
    const cues = generateTranscriptCues(ir, voiceTexts);
    expect(cues[0]!.endSample).toBe(8000); // unchanged
  });

  it("crossfade clamp is no-op for contiguous chunks (endSample === nextStart)", () => {
    const clips = [
      makeVoiceClip("c0", 0, 10000, 0),
      makeVoiceClip("c1", 10000, 5000, 0),
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([[0, ["A.", "B."]]]);
    const cues = generateTranscriptCues(ir, voiceTexts);
    expect(cues[0]!.endSample).toBe(10000); // unchanged
  });

  it("throws when chunk counter exceeds voiceTexts entries", () => {
    const clips = [
      makeVoiceClip("c0", 0, 10000, 0),
      makeVoiceClip("c1", 10000, 5000, 0), // second chunk but only 1 text entry
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([[0, ["Only one."]]]);
    expect(() => generateTranscriptCues(ir, voiceTexts)).toThrow(/voiceUnitId 0/);
  });

  it("returns cues sorted ascending by startSample", () => {
    // Provide clips in order — result must be sorted
    const clips = [
      makeVoiceClip("c0", 0, 10000, 0),
      makeVoiceClip("c1", 10000, 5000, 1),
      makeVoiceClip("c2", 15000, 8000, 0),
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([
      [0, ["A.", "B."]],
      [1, ["C."]],
    ]);
    const cues = generateTranscriptCues(ir, voiceTexts);
    for (let i = 0; i < cues.length - 1; i++) {
      expect(cues[i]!.startSample).toBeLessThanOrEqual(cues[i + 1]!.startSample);
    }
  });

  it("cue.text equals the originalText at the correct chunk index", () => {
    const clips = [
      makeVoiceClip("c0", 0, 10000, 0),
      makeVoiceClip("c1", 10000, 5000, 0),
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([[0, ["First sentence.", "Second sentence."]]]);
    const cues = generateTranscriptCues(ir, voiceTexts);
    expect(cues[0]!.text).toBe("First sentence.");
    expect(cues[1]!.text).toBe("Second sentence.");
  });

  it("file clips (kind:'file') on voice track produce no cue", () => {
    const clips = [
      makeVoiceClip("c0", 0, 10000, 0),
      makeFileClip("c1", 10000, 8000),  // file clip — no cue
      makeVoiceClip("c2", 18000, 5000, 0),
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([[0, ["A.", "B."]]]);
    const cues = generateTranscriptCues(ir, voiceTexts);
    // Only 2 cues from the cache clips
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe("A.");
    expect(cues[1]!.text).toBe("B.");
  });

  it("silence clips (kind:'silence') produce no cue", () => {
    const clips = [
      makeVoiceClip("c0", 0, 10000, 0),
      makeSilenceClip("c1", 10000, 5000),
      makeVoiceClip("c2", 15000, 8000, 0),
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([[0, ["A.", "B."]]]);
    const cues = generateTranscriptCues(ir, voiceTexts);
    expect(cues).toHaveLength(2);
  });

  it("multi-voiceUnitId: each voice's chunks are tracked independently", () => {
    const clips = [
      makeVoiceClip("c0", 0, 10000, 0),   // voice 0, chunk 0
      makeVoiceClip("c1", 10000, 8000, 1), // voice 1, chunk 0
      makeVoiceClip("c2", 18000, 5000, 0), // voice 0, chunk 1
      makeVoiceClip("c3", 23000, 6000, 1), // voice 1, chunk 1
    ];
    const ir = makeIR(clips);
    const voiceTexts = new Map([
      [0, ["V0 first.", "V0 second."]],
      [1, ["V1 first.", "V1 second."]],
    ]);
    const cues = generateTranscriptCues(ir, voiceTexts);
    expect(cues[0]!.text).toBe("V0 first.");
    expect(cues[1]!.text).toBe("V1 first.");
    expect(cues[2]!.text).toBe("V0 second.");
    expect(cues[3]!.text).toBe("V1 second.");
  });
});

// ---------------------------------------------------------------------------
// samplesToTimestamp
// ---------------------------------------------------------------------------

describe("samplesToTimestamp", () => {
  it("48000 samples at 48kHz → 1 second → '00:00:01,000' (comma)", () => {
    expect(samplesToTimestamp(48000, 48000, ",")).toBe("00:00:01,000");
  });

  it("0 samples at 48kHz → '00:00:00.000' (dot)", () => {
    expect(samplesToTimestamp(0, 48000, ".")).toBe("00:00:00.000");
  });

  it("48000 * 3661 samples → '01:01:01,000' (1 hr 1 min 1 sec)", () => {
    expect(samplesToTimestamp(48000 * 3661, 48000, ",")).toBe("01:01:01,000");
  });

  it("uses dot separator for VTT", () => {
    expect(samplesToTimestamp(48000, 48000, ".")).toBe("00:00:01.000");
  });

  it("pads single-digit components to 2 digits", () => {
    // 5000ms = 5 sec → "00:00:05,000"
    const fiveSec = 5 * 48000;
    expect(samplesToTimestamp(fiveSec, 48000, ",")).toBe("00:00:05,000");
  });

  it("handles milliseconds correctly", () => {
    // 1500ms = 1 sec 500ms
    const samples = Math.round(1.5 * 48000);
    expect(samplesToTimestamp(samples, 48000, ",")).toBe("00:00:01,500");
  });
});

// ---------------------------------------------------------------------------
// formatSrt
// ---------------------------------------------------------------------------

describe("formatSrt", () => {
  const cues: TranscriptCue[] = [
    { startSample: 48000, endSample: 5 * 48000, text: "Hello world.", voiceUnitId: 0 },
    { startSample: 5 * 48000, endSample: 10 * 48000, text: "Goodbye.", voiceUnitId: 0 },
  ];

  it("starts with sequence number 1", () => {
    const srt = formatSrt(cues, SR);
    expect(srt.startsWith("1\n")).toBe(true);
  });

  it("contains sequence number 2 for second cue", () => {
    const srt = formatSrt(cues, SR);
    expect(srt).toContain("\n2\n");
  });

  it("timestamps use comma decimal separator", () => {
    const srt = formatSrt(cues, SR);
    // Should contain "00:00:01,000 --> 00:00:05,000"
    expect(srt).toContain("00:00:01,000 --> 00:00:05,000");
  });

  it("has a blank line between consecutive cues", () => {
    const srt = formatSrt(cues, SR);
    // Should contain "\n\n" between cue blocks
    expect(srt).toContain("Hello world.\n\n2\n");
  });

  it("has a trailing newline", () => {
    const srt = formatSrt(cues, SR);
    expect(srt.endsWith("\n")).toBe(true);
  });

  it("returns empty string for zero cues", () => {
    expect(formatSrt([], SR)).toBe("");
  });

  it("SRT round-trip: can parse back cue count, texts, and monotonic timestamps", () => {
    const testCues: TranscriptCue[] = [
      { startSample: 0, endSample: 48000, text: "First.", voiceUnitId: 0 },
      { startSample: 48000, endSample: 96000, text: "Second.", voiceUnitId: 0 },
      { startSample: 96000, endSample: 144000, text: "Third.", voiceUnitId: 0 },
    ];
    const srt = formatSrt(testCues, SR);
    const lines = srt.split("\n");

    // Parse: find sequence-number lines (pure digits), then timestamp, then text
    const parsedCues: { text: string; startMs: number }[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!.trim();
      if (/^\d+$/.test(line)) {
        // sequence number found
        const tsLine = lines[i + 1]!;
        const textLine = lines[i + 2]!;
        const tsMatch = tsLine.match(/(\d{2}:\d{2}:\d{2},\d{3}) --> /);
        if (tsMatch) {
          const [hh, mm, rest] = tsMatch[1]!.split(":") as [string, string, string];
          const [ss, ms] = rest.split(",") as [string, string];
          const startMs = parseInt(hh, 10) * 3600000 + parseInt(mm, 10) * 60000 +
            parseInt(ss, 10) * 1000 + parseInt(ms, 10);
          parsedCues.push({ text: textLine, startMs });
        }
        i += 3;
      } else {
        i++;
      }
    }

    expect(parsedCues).toHaveLength(3);
    expect(parsedCues[0]!.text).toBe("First.");
    expect(parsedCues[1]!.text).toBe("Second.");
    expect(parsedCues[2]!.text).toBe("Third.");
    // Monotonically increasing start timestamps
    expect(parsedCues[0]!.startMs).toBeLessThan(parsedCues[1]!.startMs);
    expect(parsedCues[1]!.startMs).toBeLessThan(parsedCues[2]!.startMs);
  });
});

// ---------------------------------------------------------------------------
// formatVtt
// ---------------------------------------------------------------------------

describe("formatVtt", () => {
  const cues: TranscriptCue[] = [
    { startSample: 48000, endSample: 5 * 48000, text: "Hello world.", voiceUnitId: 0 },
    { startSample: 5 * 48000, endSample: 10 * 48000, text: "Goodbye.", voiceUnitId: 0 },
  ];

  it("starts with 'WEBVTT\\n\\n'", () => {
    const vtt = formatVtt(cues, SR);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
  });

  it("timestamps use dot decimal separator", () => {
    const vtt = formatVtt(cues, SR);
    expect(vtt).toContain("00:00:01.000 --> 00:00:05.000");
  });

  it("does NOT contain sequence numbers (no '^1$' match in cue block)", () => {
    const vtt = formatVtt(cues, SR);
    // Split into cue blocks (after WEBVTT header)
    const content = vtt.slice("WEBVTT\n\n".length);
    const blocks = content.split("\n\n").filter(b => b.trim() !== "");
    for (const block of blocks) {
      const firstLine = block.split("\n")[0]!;
      // First line of each cue block must NOT be a bare integer
      expect(/^\d+$/.test(firstLine.trim())).toBe(false);
    }
  });

  it("has a trailing newline", () => {
    const vtt = formatVtt(cues, SR);
    expect(vtt.endsWith("\n")).toBe(true);
  });

  it("returns 'WEBVTT\\n\\n' header for zero cues", () => {
    expect(formatVtt([], SR)).toBe("WEBVTT\n\n");
  });

  it("VTT round-trip: can parse back cue count, texts, and timestamps", () => {
    const testCues: TranscriptCue[] = [
      { startSample: 0, endSample: 48000, text: "Alpha.", voiceUnitId: 0 },
      { startSample: 48000, endSample: 96000, text: "Beta.", voiceUnitId: 0 },
    ];
    const vtt = formatVtt(testCues, SR);
    // Strip WEBVTT header, split by blank lines
    const content = vtt.replace(/^WEBVTT\n\n/, "");
    const blocks = content.split("\n\n").filter(b => b.trim() !== "");

    expect(blocks).toHaveLength(2);

    // Parse each block: first line is timestamp, second is text
    const parsed = blocks.map(block => {
      const lines = block.split("\n");
      const tsLine = lines[0]!;
      const text = lines[1]!;
      const tsMatch = tsLine.match(/(\d{2}:\d{2}:\d{2}\.\d{3}) --> /);
      const [hh, mm, rest] = tsMatch![1]!.split(":") as [string, string, string];
      const [ss, ms] = rest.split(".") as [string, string];
      const startMs = parseInt(hh, 10) * 3600000 + parseInt(mm, 10) * 60000 +
        parseInt(ss, 10) * 1000 + parseInt(ms, 10);
      return { text, startMs };
    });

    expect(parsed[0]!.text).toBe("Alpha.");
    expect(parsed[1]!.text).toBe("Beta.");
    expect(parsed[0]!.startMs).toBeLessThan(parsed[1]!.startMs);
  });
});

// ---------------------------------------------------------------------------
// formatTxt
// ---------------------------------------------------------------------------

describe("formatTxt", () => {
  it("no chapters: cue texts joined by '\\n\\n' with trailing newline", () => {
    const cues: TranscriptCue[] = [
      { startSample: 0, endSample: 10000, text: "First.", voiceUnitId: 0 },
      { startSample: 10000, endSample: 20000, text: "Second.", voiceUnitId: 0 },
    ];
    const ir = makeIR([], []);
    const txt = formatTxt(ir, cues);
    expect(txt).toBe("First.\n\nSecond.\n");
  });

  it("with 2 chapters: '## Chapter1' before chapter 1's cues", () => {
    const chapters: ChapterIR[] = [
      { title: "Chapter1", startSample: 0, endSample: 20000 },
      { title: "Chapter2", startSample: 20000, endSample: 40000 },
    ];
    const cues: TranscriptCue[] = [
      { startSample: 0, endSample: 10000, text: "Intro text.", voiceUnitId: 0 },
      { startSample: 10000, endSample: 20000, text: "More intro.", voiceUnitId: 0 },
      { startSample: 20000, endSample: 30000, text: "Outro text.", voiceUnitId: 1 },
    ];
    const ir = makeIR([], chapters);
    const txt = formatTxt(ir, cues);
    expect(txt).toContain("## Chapter1");
    expect(txt).toContain("## Chapter2");
    // Chapter1 must appear before Chapter2
    expect(txt.indexOf("## Chapter1")).toBeLessThan(txt.indexOf("## Chapter2"));
    // Chapter1's cues appear after its header
    expect(txt.indexOf("Intro text.")).toBeGreaterThan(txt.indexOf("## Chapter1"));
    // Chapter2's cues appear after its header
    expect(txt.indexOf("Outro text.")).toBeGreaterThan(txt.indexOf("## Chapter2"));
  });

  it("with 2 chapters: no '##' headers when there are no chapters", () => {
    const ir = makeIR([], []);
    const cues: TranscriptCue[] = [
      { startSample: 0, endSample: 5000, text: "Text.", voiceUnitId: 0 },
    ];
    const txt = formatTxt(ir, cues);
    expect(txt).not.toContain("##");
  });

  it("trailing newline is always present", () => {
    const ir = makeIR([], []);
    const cues: TranscriptCue[] = [
      { startSample: 0, endSample: 5000, text: "Text.", voiceUnitId: 0 },
    ];
    expect(formatTxt(ir, cues).endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findChapterIndex export verification
// ---------------------------------------------------------------------------

describe("findChapterIndex (exported from chapters.ts)", () => {
  it("is importable from report.ts", () => {
    expect(typeof findChapterIndex).toBe("function");
  });

  it("returns correct chapter index for a sample in the middle of chapter 0", () => {
    const chapters: ChapterIR[] = [
      { title: "A", startSample: 0, endSample: 10000 },
      { title: "B", startSample: 10000, endSample: 20000 },
    ];
    expect(findChapterIndex(chapters, 5000)).toBe(0);
    expect(findChapterIndex(chapters, 10000)).toBe(1);
  });
});
