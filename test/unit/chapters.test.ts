// Unit tests for src/compiler/chapters.ts — conversion formula and post-pass pinning.
// (Round-trip golden tests live in test/golden/chapters.test.ts.)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeID3 from "node-id3";
import { samplesToMs, writeChapterTags } from "../../src/compiler/chapters.js";
import type { ChapterIR, EpisodeIR } from "../../src/ir/phase-b.js";

const SR = 48000;

// ---------------------------------------------------------------------------
// samplesToMs — formula correctness
// ---------------------------------------------------------------------------

describe("samplesToMs", () => {
  it("converts 0 samples to 0 ms", () => {
    expect(samplesToMs(0, SR)).toBe(0);
  });

  it("converts exact-second samples correctly", () => {
    expect(samplesToMs(48000, SR)).toBe(1000);
    expect(samplesToMs(480000, SR)).toBe(10000);
  });

  it("uses Math.round (not floor or ceil)", () => {
    // non-integer result: 1 sample @ 48000 → 0.0208... ms → rounds to 0
    expect(samplesToMs(1, SR)).toBe(0);
    // 24 samples @ 48000 → 0.5 ms → rounds to 1 (Math.round rounds 0.5 up)
    expect(samplesToMs(24, SR)).toBe(1);
    // 72000 samples → exactly 1500 ms
    expect(samplesToMs(72000, SR)).toBe(1500);
  });

  it("matches the architecture formula: Math.round(sample / sampleRate * 1000)", () => {
    // Mix of exact and non-round inputs to cover rounding tension
    const cases: number[] = [0, 48000, 96000, 211200, 211537, 480000, 960000];
    for (const samples of cases) {
      expect(samplesToMs(samples, SR)).toBe(Math.round((samples / SR) * 1000));
    }
  });

  it("works with non-standard sample rates", () => {
    expect(samplesToMs(24000, 24000)).toBe(1000);
    expect(samplesToMs(44100, 44100)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// writeChapterTags unit tests — exercise post-pass pinning logic directly.
//
// These use a minimal fake mp3 (valid enough for node-id3.write()) so we can
// call writeChapterTags and read tags back without running ffmpeg.
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "soundstage-chapters-unit-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Minimal file that node-id3.write() can prepend an ID3 header to. */
async function makeMinimalMp3(path: string): Promise<void> {
  // 4-byte MPEG sync word — node-id3 prepends the ID3 block, audio bytes follow.
  await writeFile(path, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
}

describe("writeChapterTags: lastChapter.endMs is pinned to totalMs", () => {
  it("last chapter endMs equals samplesToMs(totalSamples) even when ch.endSample differs", async () => {
    const mp3 = join(tmpDir, "pin-test.mp3");
    await makeMinimalMp3(mp3);

    const chapters: ChapterIR[] = [
      { title: "Intro", startSample: 0, endSample: 96000 },
      // ch.endSample intentionally lower than totalSamples to expose a pinning bug
      { title: "Main", startSample: 96000, endSample: 192000 },
    ];
    const totalSamples = 200000; // > ch.endSample of 192000
    const episode: EpisodeIR = { title: "Test" };

    writeChapterTags(mp3, chapters, SR, totalSamples, episode);

    const tags = NodeID3.read(mp3);
    const lastChap = tags.chapter![tags.chapter!.length - 1]!;
    const expectedEndMs = Math.round((totalSamples / SR) * 1000);

    // Pinning must use totalSamples, not ch.endSample
    expect(lastChap.endTimeMs).toBe(expectedEndMs);
    // Verify ch.endSample would give a different value (sanity: the test is non-trivial)
    expect(samplesToMs(192000, SR)).not.toBe(expectedEndMs);
  });
});

describe("writeChapterTags: write() does not accumulate frames on re-render", () => {
  it("calling writeChapterTags twice on the same mp3 does not double chapters", async () => {
    const mp3 = join(tmpDir, "re-render-test.mp3");
    await makeMinimalMp3(mp3);

    const chapters: ChapterIR[] = [
      { title: "Intro", startSample: 0, endSample: 96000 },
    ];
    const episode: EpisodeIR = { title: "Test" };

    writeChapterTags(mp3, chapters, SR, 96000, episode);
    writeChapterTags(mp3, chapters, SR, 96000, episode); // second render

    const tags = NodeID3.read(mp3);
    expect(tags.chapter, "chapters must not accumulate across re-renders").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// writeChapterTags: episode-level ID3 text frames (TIT2/TPE1)
// ---------------------------------------------------------------------------

describe("writeChapterTags: episode text frames (title + artist)", () => {
  it("writes TIT2 (title) and TPE1 (artist) when both episode.title and episode.author are set", async () => {
    const mp3 = join(tmpDir, "text-frames-full.mp3");
    await makeMinimalMp3(mp3);

    const chapters: ChapterIR[] = [
      { title: "Intro", startSample: 0, endSample: 96000 },
    ];
    const episode: EpisodeIR = { title: "Grafex Weekly #12", author: "Grafex" };

    writeChapterTags(mp3, chapters, SR, 96000, episode);

    const tags = NodeID3.read(mp3);
    expect(tags.title, "TIT2 must equal episode.title").toBe("Grafex Weekly #12");
    expect(tags.artist, "TPE1 must equal episode.author").toBe("Grafex");
  });

  it("writes TIT2 but no TPE1 when episode.author is absent", async () => {
    const mp3 = join(tmpDir, "text-frames-no-author.mp3");
    await makeMinimalMp3(mp3);

    const chapters: ChapterIR[] = [
      { title: "Intro", startSample: 0, endSample: 96000 },
    ];
    const episode: EpisodeIR = { title: "Untitled Episode" };

    writeChapterTags(mp3, chapters, SR, 96000, episode);

    const tags = NodeID3.read(mp3);
    expect(tags.title).toBe("Untitled Episode");
    // No author → no artist frame
    expect(tags.artist).toBeUndefined();
  });

  it("text frames survive re-render (no accumulation)", async () => {
    const mp3 = join(tmpDir, "text-frames-rerender.mp3");
    await makeMinimalMp3(mp3);

    const chapters: ChapterIR[] = [{ title: "Intro", startSample: 0, endSample: 96000 }];
    const episode: EpisodeIR = { title: "My Show", author: "Me" };

    writeChapterTags(mp3, chapters, SR, 96000, episode);
    writeChapterTags(mp3, chapters, SR, 96000, episode);

    const tags = NodeID3.read(mp3);
    expect(tags.title).toBe("My Show");
    expect(tags.artist).toBe("Me");
    expect(tags.chapter).toHaveLength(1);
  });
});
