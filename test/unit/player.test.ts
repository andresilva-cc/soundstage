// Unit tests for src/compiler/player.ts — HTML template generation.
// Pure function tests (no I/O, no ffmpeg).
//
// Acceptance criteria covered:
// - One <audio> element with correct relative (URL-encoded) src
// - N <button> elements for N chapters
// - onclick contains startSample/sampleRate as a literal float (computed at generation time)
// - Waveform embedded as data:image/png;base64,...
// - Episode title in <title> and heading
// - No <script src> or <link href> pointing to external URLs
// - HTML entities and single quotes escaped in text/attributes
// - Chapter titles escaped in button text
// - mp3 filename URL-encoded for use as audio src

import { describe, it, expect } from "vitest";
import { buildPlayerHtml } from "../../src/compiler/player.js";
import type { IR } from "../../src/ir/phase-b.js";

const SR = 48000;

function makeIR(
  chapters: { title: string; startSample: number; endSample: number }[],
  episode: Partial<IR["episode"]> = {},
): IR {
  return {
    schemaVersion: 3,
    sampleRate: SR,
    channels: 1,
    episode: { title: "Test Episode", ...episode },
    tracks: [{ trackId: "voice" }],
    clips: [],
    ducking: [],
    chapters,
    loudness: { targetI: -16, targetTP: -1.5, targetLRA: 11 },
    render: { outputs: ["wav", "mp3"] },
  };
}

const FAKE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const MP3_FILE = "episode.mp3";

describe("buildPlayerHtml", () => {
  it("contains exactly one <audio> element", () => {
    const ir = makeIR([]);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    const matches = html.match(/<audio\b[^>]*>/gi) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("<audio> src attribute equals the mp3 filename (relative, URL-encoded)", () => {
    const ir = makeIR([]);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    // Plain filename has no special chars — encodeURIComponent("episode.mp3") = "episode.mp3"
    expect(html).toContain(`src="${MP3_FILE}"`);
  });

  it("<audio> src does not contain a directory separator", () => {
    const ir = makeIR([]);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    // The src value should be a bare filename, not a path like /out/episode.mp3
    const srcMatch = html.match(/src="([^"]+)"/);
    expect(srcMatch).not.toBeNull();
    // URL-encoded filename must not contain an unencoded '/'
    expect(srcMatch![1]).not.toContain("/");
  });

  it("<audio> src URL-encodes # in the filename", () => {
    const ir = makeIR([]);
    const html = buildPlayerHtml(ir, "episode #1.mp3", FAKE_B64);
    // # must be encoded as %23, space as %20; raw # would break browser URL parsing
    expect(html).toContain('src="episode%20%231.mp3"');
    expect(html).not.toContain('src="episode #1.mp3"');
  });

  it("<audio> src URL-encodes spaces in the filename", () => {
    const ir = makeIR([]);
    const html = buildPlayerHtml(ir, "my episode.mp3", FAKE_B64);
    expect(html).toContain('src="my%20episode.mp3"');
  });

  it("contains exactly N <button> elements for N chapters", () => {
    const chapters = [
      { title: "Intro", startSample: 0,      endSample: 48000  },
      { title: "Main",  startSample: 48000,  endSample: 96000  },
      { title: "Outro", startSample: 96000,  endSample: 144000 },
    ];
    const ir = makeIR(chapters);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    const buttons = html.match(/<button\b[^>]*>/gi) ?? [];
    expect(buttons).toHaveLength(3);
  });

  it("contains 0 buttons for an IR with no chapters", () => {
    const ir = makeIR([]);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    const buttons = html.match(/<button\b[^>]*>/gi) ?? [];
    expect(buttons).toHaveLength(0);
  });

  it("chapter button onclick contains startSample/sampleRate as a literal number (no client-side division)", () => {
    const chapters = [
      { title: "Intro", startSample: 0,      endSample: 48000 },
      { title: "Main",  startSample: 96000,  endSample: 192000 },
    ];
    const ir = makeIR(chapters);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);

    // Intro: 0 / 48000 = 0
    expect(html).toContain("currentTime=0");
    // Main: 96000 / 48000 = 2
    expect(html).toContain("currentTime=2");

    // Must NOT contain the raw sample values (those would indicate client-side division)
    expect(html).not.toMatch(/currentTime=96000/);
  });

  it("chapter button onclick time is startSample / sampleRate (non-integer case)", () => {
    // 72000 / 48000 = 1.5 — verify non-integer is serialized correctly
    const chapters = [
      { title: "A", startSample: 0,     endSample: 72000 },
      { title: "B", startSample: 72000, endSample: 144000 },
    ];
    const ir = makeIR(chapters);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    expect(html).toContain("currentTime=1.5");
  });

  it("waveform image is embedded as data:image/png;base64", () => {
    const ir = makeIR([]);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    expect(html).toContain(`data:image/png;base64,${FAKE_B64}`);
  });

  it("waveform data URI appears in an <img> src attribute", () => {
    const ir = makeIR([]);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    // Use string search to avoid regex metacharacter escaping issues with the base64 payload.
    expect(html).toContain(`<img`);
    expect(html).toContain(`src="data:image/png;base64,${FAKE_B64}"`);
    // Confirm the img tag comes before the src value (order sanity)
    const imgIdx = html.indexOf("<img");
    const srcIdx = html.indexOf(`src="data:image/png;base64,`);
    expect(imgIdx).toBeGreaterThanOrEqual(0);
    expect(srcIdx).toBeGreaterThan(imgIdx);
  });

  it("episode title appears in <title>", () => {
    const ir = makeIR([], { title: "My Podcast" });
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    expect(html).toContain("<title>My Podcast</title>");
  });

  it("episode title appears in a heading element", () => {
    const ir = makeIR([], { title: "My Podcast" });
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    expect(html).toMatch(/<h[1-6][^>]*>My Podcast/);
  });

  it("author combined with title in heading and title when author is set", () => {
    const ir = makeIR([], { title: "My Podcast", author: "Jane Doe" });
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    expect(html).toContain("My Podcast — Jane Doe");
  });

  it("title without author shows only title (no em-dash)", () => {
    const ir = makeIR([], { title: "Solo Show" });
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    // The heading should not contain " — " when no author is set
    const titleTagMatch = html.match(/<title>([^<]+)<\/title>/);
    expect(titleTagMatch).not.toBeNull();
    expect(titleTagMatch![1]).not.toContain("—");
  });

  it("contains no <script src=...> pointing to external URLs", () => {
    const ir = makeIR([]);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    // Any <script> with a src attribute would be an external load
    expect(html).not.toMatch(/<script\b[^>]+\bsrc\s*=/i);
  });

  it("contains no <link href=...> pointing to external URLs", () => {
    const ir = makeIR([]);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    // Any <link href=...> would be an external load
    expect(html).not.toMatch(/<link\b[^>]+\bhref\s*=/i);
  });

  it("chapter title is included in button text", () => {
    const ir = makeIR([
      { title: "Opening Act", startSample: 0, endSample: 48000 },
    ]);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    expect(html).toContain("Opening Act");
  });

  it("HTML entities in episode title are escaped", () => {
    const ir = makeIR([], { title: "News & <Events>" });
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    // Should not contain raw < or & in the title context
    expect(html).not.toContain("<title>News & <Events></title>");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;");
  });

  // FIX 2: Chapter title escaping
  it("HTML entities in chapter title are escaped in button text", () => {
    const ir = makeIR([
      { title: 'Intro <"Special"> & More', startSample: 0, endSample: 48000 },
    ]);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gi) ?? [];
    expect(buttons).toHaveLength(1);
    const btnText = buttons[0]!;
    expect(btnText).not.toContain('<"Special">');
    expect(btnText).toContain("&lt;");
    expect(btnText).toContain("&quot;");
    expect(btnText).toContain("&amp;");
  });

  // FIX 3: Single-quote escaping
  it("single quotes in episode title are escaped as &#39;", () => {
    const ir = makeIR([], { title: "It's a show" });
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    // Raw single quote must not appear in escaped contexts
    expect(html).not.toContain("<title>It's a show</title>");
    expect(html).toContain("&#39;");
  });

  it("single quotes in chapter title are escaped as &#39;", () => {
    const ir = makeIR([
      { title: "Don't skip this", startSample: 0, endSample: 48000 },
    ]);
    const html = buildPlayerHtml(ir, MP3_FILE, FAKE_B64);
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gi) ?? [];
    expect(buttons[0]).toContain("&#39;");
    expect(buttons[0]).not.toContain("Don't skip this");
  });
});
