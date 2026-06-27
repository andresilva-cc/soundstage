// Unit tests for src/compiler/feed.ts
// All tests are pure — no I/O, no ffprobe, no network.

import { describe, it, expect, vi, afterEach } from "vitest";
import { XMLParser } from "fast-xml-parser";
import {
  validateFeedConfig,
  xmlEscape,
  secondsToHms,
  buildFeedXml,
  ITUNES_CATEGORIES,
  ITUNES_CATEGORY_MAP,
} from "../../src/compiler/feed.js";
import type { EpisodeMeta, FeedConfig } from "../../src/compiler/feed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidShowConfig(): Record<string, unknown> {
  return {
    title: "My Podcast",
    description: "A weekly show",
    author: "André Silva",
    email: "andre@example.com",
    imageUrl: "https://example.com/cover.jpg",
    category: "Technology",
    language: "en-us",
    baseUrl: "https://example.com/episodes/",
    feedUrl: "https://example.com/feed.xml",
    link: "https://example.com",
    explicit: false,
  };
}

function makeValidEpisodeConfig(): Record<string, unknown> {
  return {
    file: "./ep1.mp3",
    title: "Episode 1",
    description: "First episode",
    pubDate: "2026-06-01T00:00:00Z",
    guid: "ep1-2026-06-01",
    explicit: false,
  };
}

function makeValidConfig(): Record<string, unknown> {
  return {
    show: makeValidShowConfig(),
    episodes: [makeValidEpisodeConfig()],
  };
}

function makeEpisodeMeta(overrides: Partial<EpisodeMeta> = {}): EpisodeMeta {
  return {
    guid: "ep1-2026-06-01",
    title: "Episode 1",
    description: "First episode",
    pubDate: "2026-06-01T00:00:00Z",
    url: "https://example.com/episodes/ep1.mp3",
    byteSize: 1234567,
    durationSeconds: 3661,
    explicit: false,
    ...overrides,
  };
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

// ---------------------------------------------------------------------------
// validateFeedConfig — missing required show fields
// ---------------------------------------------------------------------------

describe("validateFeedConfig — required field validation", () => {
  it("throws when show.title is missing", () => {
    const raw = makeValidConfig();
    delete (raw.show as Record<string, unknown>).title;
    expect(() => validateFeedConfig(raw)).toThrow(/title/);
  });

  it("throws when show.description is missing", () => {
    const raw = makeValidConfig();
    delete (raw.show as Record<string, unknown>).description;
    expect(() => validateFeedConfig(raw)).toThrow(/description/);
  });

  it("throws when show.author is missing", () => {
    const raw = makeValidConfig();
    delete (raw.show as Record<string, unknown>).author;
    expect(() => validateFeedConfig(raw)).toThrow(/author/);
  });

  it("throws when show.imageUrl is missing", () => {
    const raw = makeValidConfig();
    delete (raw.show as Record<string, unknown>).imageUrl;
    expect(() => validateFeedConfig(raw)).toThrow(/imageUrl/);
  });

  it("throws when show.category is missing", () => {
    const raw = makeValidConfig();
    delete (raw.show as Record<string, unknown>).category;
    expect(() => validateFeedConfig(raw)).toThrow(/category/);
  });

  it("throws when show.language is missing", () => {
    const raw = makeValidConfig();
    delete (raw.show as Record<string, unknown>).language;
    expect(() => validateFeedConfig(raw)).toThrow(/language/);
  });

  it("throws when show.baseUrl is missing", () => {
    const raw = makeValidConfig();
    delete (raw.show as Record<string, unknown>).baseUrl;
    expect(() => validateFeedConfig(raw)).toThrow(/baseUrl/);
  });

  it("throws when show.feedUrl is missing", () => {
    const raw = makeValidConfig();
    delete (raw.show as Record<string, unknown>).feedUrl;
    expect(() => validateFeedConfig(raw)).toThrow(/feedUrl/);
  });

  it("throws when an episode has no pubDate", () => {
    const raw = makeValidConfig();
    const ep0 = (raw.episodes as Record<string, unknown>[])[0];
    if (ep0) delete ep0.pubDate;
    expect(() => validateFeedConfig(raw)).toThrow(/pubDate/);
  });

  it("throws when an episode has no guid", () => {
    const raw = makeValidConfig();
    const ep0 = (raw.episodes as Record<string, unknown>[])[0];
    if (ep0) delete ep0.guid;
    expect(() => validateFeedConfig(raw)).toThrow(/guid/);
  });

  it("throws when an episode has no file", () => {
    const raw = makeValidConfig();
    const ep0 = (raw.episodes as Record<string, unknown>[])[0];
    if (ep0) delete ep0.file;
    expect(() => validateFeedConfig(raw)).toThrow(/file/);
  });

  it("throws when an episode has no title", () => {
    const raw = makeValidConfig();
    const ep0 = (raw.episodes as Record<string, unknown>[])[0];
    if (ep0) delete ep0.title;
    expect(() => validateFeedConfig(raw)).toThrow(/title/);
  });
});

// ---------------------------------------------------------------------------
// validateFeedConfig — pubDate validation
// ---------------------------------------------------------------------------

describe("validateFeedConfig — pubDate validation", () => {
  it("throws a descriptive error when pubDate is not a valid date", () => {
    const raw = makeValidConfig();
    const ep0 = (raw.episodes as Record<string, unknown>[])[0];
    if (ep0) ep0.pubDate = "2026-13-01";
    expect(() => validateFeedConfig(raw)).toThrow(/pubDate.*not a valid date|not a valid date.*pubDate/i);
  });

  it("throws when pubDate is a non-date string", () => {
    const raw = makeValidConfig();
    const ep0 = (raw.episodes as Record<string, unknown>[])[0];
    if (ep0) ep0.pubDate = "not-a-date";
    expect(() => validateFeedConfig(raw)).toThrow(/pubDate/);
  });

  it("accepts a valid ISO 8601 date", () => {
    const raw = makeValidConfig();
    expect(() => validateFeedConfig(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateFeedConfig — baseUrl normalization
// ---------------------------------------------------------------------------

describe("validateFeedConfig — baseUrl normalization", () => {
  it("appends trailing slash when missing", () => {
    const raw = makeValidConfig();
    (raw.show as Record<string, unknown>).baseUrl = "https://example.com/ep";
    const config = validateFeedConfig(raw);
    expect(config.show.baseUrl).toBe("https://example.com/ep/");
  });

  it("preserves existing trailing slash", () => {
    const raw = makeValidConfig();
    (raw.show as Record<string, unknown>).baseUrl = "https://example.com/episodes/";
    const config = validateFeedConfig(raw);
    expect(config.show.baseUrl).toBe("https://example.com/episodes/");
  });
});

// ---------------------------------------------------------------------------
// validateFeedConfig — category taxonomy validation
// ---------------------------------------------------------------------------

describe("validateFeedConfig — category taxonomy", () => {
  it("throws a taxonomy-specific error when category is not valid", () => {
    const raw = makeValidConfig();
    (raw.show as Record<string, unknown>).category = "Nonsense Category";
    expect(() => validateFeedConfig(raw)).toThrow(/Apple Podcasts taxonomy/);
  });

  it("accepts 'Technology' (valid top-level category)", () => {
    const raw = makeValidConfig();
    (raw.show as Record<string, unknown>).category = "Technology";
    expect(() => validateFeedConfig(raw)).not.toThrow();
  });

  it("accepts 'True Crime' (valid top-level category)", () => {
    const raw = makeValidConfig();
    (raw.show as Record<string, unknown>).category = "True Crime";
    expect(() => validateFeedConfig(raw)).not.toThrow();
  });

  it("accepts 'Mental Health' (valid subcategory of Health & Fitness)", () => {
    const raw = makeValidConfig();
    (raw.show as Record<string, unknown>).category = "Mental Health";
    expect(() => validateFeedConfig(raw)).not.toThrow();
  });

  it("accepts 'Comedy Interviews' (valid subcategory of Comedy)", () => {
    const raw = makeValidConfig();
    (raw.show as Record<string, unknown>).category = "Comedy Interviews";
    expect(() => validateFeedConfig(raw)).not.toThrow();
  });
});

describe("ITUNES_CATEGORY_MAP", () => {
  it("is a ReadonlyMap", () => {
    expect(ITUNES_CATEGORY_MAP).toBeInstanceOf(Map);
  });

  it("Technology has empty subcategory array (top-level only)", () => {
    expect(ITUNES_CATEGORY_MAP.get("Technology")).toEqual([]);
  });

  it("Comedy has subcategories including 'Comedy Interviews'", () => {
    expect(ITUNES_CATEGORY_MAP.get("Comedy")).toContain("Comedy Interviews");
  });

  it("Health & Fitness has 'Mental Health' as a subcategory", () => {
    expect(ITUNES_CATEGORY_MAP.get("Health & Fitness")).toContain("Mental Health");
  });
});

// ---------------------------------------------------------------------------
// validateFeedConfig — duplicate GUID detection
// ---------------------------------------------------------------------------

describe("validateFeedConfig — duplicate GUID detection", () => {
  it("throws naming the duplicate guid when two episodes share a guid", () => {
    const raw = makeValidConfig();
    const ep = makeValidEpisodeConfig();
    (raw.episodes as Record<string, unknown>[]).push({ ...ep, title: "Episode 2" });
    expect(() => validateFeedConfig(raw)).toThrow(/duplicate.*guid|guid.*duplicate/i);
  });

  it("accepts two episodes with distinct guids", () => {
    const raw = makeValidConfig();
    const ep2 = { ...makeValidEpisodeConfig(), guid: "ep2-2026-06-02", title: "Episode 2" };
    (raw.episodes as Record<string, unknown>[]).push(ep2);
    expect(() => validateFeedConfig(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateFeedConfig — email warning
// ---------------------------------------------------------------------------

describe("validateFeedConfig — email warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns to stderr (but does not throw) when email is absent", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const raw = makeValidConfig();
    delete (raw.show as Record<string, unknown>).email;
    expect(() => validateFeedConfig(raw)).not.toThrow();
    const allOutput = spy.mock.calls.map(c => String(c[0])).join("");
    expect(allOutput).toContain("Apple Podcasts submission");
  });

  it("does not warn when email is present", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const raw = makeValidConfig();
    (raw.show as Record<string, unknown>).email = "host@example.com";
    validateFeedConfig(raw);
    const allOutput = spy.mock.calls.map(c => String(c[0])).join("");
    expect(allOutput).not.toContain("Apple Podcasts submission");
  });
});

// ---------------------------------------------------------------------------
// ITUNES_CATEGORIES constant
// ---------------------------------------------------------------------------

describe("ITUNES_CATEGORIES", () => {
  it("is a ReadonlySet<string>", () => {
    expect(ITUNES_CATEGORIES).toBeInstanceOf(Set);
  });

  it("contains 'Technology'", () => {
    expect(ITUNES_CATEGORIES.has("Technology")).toBe(true);
  });

  it("contains 'True Crime'", () => {
    expect(ITUNES_CATEGORIES.has("True Crime")).toBe(true);
  });

  it("does not contain 'Nonsense Category'", () => {
    expect(ITUNES_CATEGORIES.has("Nonsense Category")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// xmlEscape
// ---------------------------------------------------------------------------

describe("xmlEscape", () => {
  it("escapes & < > in a mixed string", () => {
    expect(xmlEscape("A & <B>")).toBe("A &amp; &lt;B&gt;");
  });

  it("escapes double-quotes and single-quotes", () => {
    expect(xmlEscape('say "hi" and \'bye\'')).toBe("say &quot;hi&quot; and &#39;bye&#39;");
  });

  it("passes through plain alphanumeric text unchanged", () => {
    expect(xmlEscape("Hello world 123")).toBe("Hello world 123");
  });

  it("escapes > correctly", () => {
    expect(xmlEscape("a>b")).toBe("a&gt;b");
  });
});

// ---------------------------------------------------------------------------
// secondsToHms
// ---------------------------------------------------------------------------

describe("secondsToHms", () => {
  it("returns '00:00:00' for 0 seconds", () => {
    expect(secondsToHms(0)).toBe("00:00:00");
  });

  it("returns '01:01:01' for 3661 seconds", () => {
    expect(secondsToHms(3661)).toBe("01:01:01");
  });

  it("returns '00:01:30' for 90 seconds", () => {
    expect(secondsToHms(90)).toBe("00:01:30");
  });

  it("returns '00:00:59' for 59 seconds", () => {
    expect(secondsToHms(59)).toBe("00:00:59");
  });
});

// ---------------------------------------------------------------------------
// buildFeedXml
// ---------------------------------------------------------------------------

function buildValidConfig(showOverrides: Partial<Record<string, unknown>> = {}): FeedConfig {
  const raw = makeValidConfig();
  Object.assign(raw.show as Record<string, unknown>, showOverrides);
  return validateFeedConfig(raw);
}

describe("buildFeedXml — XML declaration and root element", () => {
  it("starts with the XML declaration", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("rss element has version='2.0'", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain('version="2.0"');
  });

  it("rss element has itunes xmlns", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"');
  });

  it("rss element has atom xmlns", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain('xmlns:atom="http://www.w3.org/2005/Atom"');
  });
});

describe("buildFeedXml — channel elements", () => {
  it("contains <title>", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain("<title>");
  });

  it("contains <link>", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain("<link>");
  });

  it("contains <description>", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain("<description>");
  });

  it("contains <language>", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain("<language>");
  });

  it("contains atom:link self-referential element", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain('rel="self"');
    expect(xml).toContain('type="application/rss+xml"');
    expect(xml).toContain("https://example.com/feed.xml");
  });

  it("contains <itunes:author>", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain("<itunes:author>");
  });

  it("contains <itunes:image href>", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain("<itunes:image");
    expect(xml).toContain("href=");
  });

  it("top-level category emits flat <itunes:category text='…'/>", () => {
    const config = buildValidConfig({ category: "Technology" });
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain('<itunes:category text="Technology"/>');
    expect(xml).not.toMatch(/<itunes:category text="Technology">\s*<itunes:category/);
  });

  it("subcategory emits nested <itunes:category text='Parent'><itunes:category text='Sub'/></itunes:category>", () => {
    const config = buildValidConfig({ category: "Mental Health" });
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain('<itunes:category text="Health &amp; Fitness"><itunes:category text="Mental Health"/></itunes:category>');
  });

  it("Comedy subcategory 'Comedy Interviews' emits nested form", () => {
    const config = buildValidConfig({ category: "Comedy Interviews" });
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain('<itunes:category text="Comedy"><itunes:category text="Comedy Interviews"/></itunes:category>');
  });

  it("channel-level itunes:explicit is 'true' when show.explicit=true", () => {
    const config = buildValidConfig({ explicit: true });
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    // Channel-level tag (before first <item>)
    const channelSection = xml.split("<item>")[0];
    expect(channelSection).toContain("<itunes:explicit>true</itunes:explicit>");
  });

  it("channel-level itunes:explicit is 'false' when show.explicit=false", () => {
    const config = buildValidConfig({ explicit: false });
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    const channelSection = xml.split("<item>")[0];
    expect(channelSection).toContain("<itunes:explicit>false</itunes:explicit>");
  });

  it("contains itunes:owner with name and email when email is set", () => {
    const config = buildValidConfig({ email: "host@example.com" });
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain("<itunes:owner>");
    expect(xml).toContain("<itunes:name>");
    expect(xml).toContain("<itunes:email>");
  });

  it("omits itunes:owner when email is absent", () => {
    const raw = makeValidConfig();
    delete (raw.show as Record<string, unknown>).email;
    // Silence stderr for this test
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const config = validateFeedConfig(raw);
    spy.mockRestore();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).not.toContain("<itunes:owner>");
  });
});

describe("buildFeedXml — items", () => {
  it("a 2-episode config produces exactly 2 <item> elements", () => {
    const config = buildValidConfig();
    const meta = [
      makeEpisodeMeta({ guid: "ep1", title: "Episode 1" }),
      makeEpisodeMeta({ guid: "ep2", title: "Episode 2", url: "https://example.com/episodes/ep2.mp3" }),
    ];
    const xml = buildFeedXml(config, meta);
    const count = (xml.match(/<item>/g) ?? []).length;
    expect(count).toBe(2);
  });

  it("guid has isPermaLink='false'", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain('isPermaLink="false"');
  });

  it("pubDate is RFC 822 conversion of the ISO 8601 config string", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta({ pubDate: "2026-06-01T00:00:00Z" })]);
    expect(xml).toContain("01 Jun 2026");
  });

  it("enclosure url matches baseUrl + basename of file", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta({ url: "https://example.com/episodes/ep1.mp3" })]);
    expect(xml).toContain('url="https://example.com/episodes/ep1.mp3"');
  });

  it("enclosure length matches byteSize", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta({ byteSize: 1234567 })]);
    expect(xml).toContain('length="1234567"');
  });

  it("enclosure type is 'audio/mpeg'", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain('type="audio/mpeg"');
  });

  it("itunes:duration matches secondsToHms(durationSeconds)", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta({ durationSeconds: 3661 })]);
    expect(xml).toContain("<itunes:duration>01:01:01</itunes:duration>");
  });

  it("item-level itunes:explicit is 'true' when explicit=true", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta({ explicit: true })]);
    const itemSection = xml.split("<item>")[1];
    expect(itemSection).toContain("<itunes:explicit>true</itunes:explicit>");
  });

  it("item-level itunes:explicit is 'false' when explicit=false", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta({ explicit: false })]);
    const itemSection = xml.split("<item>")[1];
    expect(itemSection).toContain("<itunes:explicit>false</itunes:explicit>");
  });
});

describe("buildFeedXml — XML escaping", () => {
  it("episode title containing < > & is XML-escaped", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta({ title: "Episode <1> & More" })]);
    expect(xml).toContain("Episode &lt;1&gt; &amp; More");
  });

  it("show description containing & is XML-escaped", () => {
    const config = buildValidConfig({ description: "A show about cats & dogs" });
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(xml).toContain("cats &amp; dogs");
  });
});

describe("buildFeedXml — well-formed XML", () => {
  it("parses without error via fast-xml-parser", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta()]);
    expect(() => xmlParser.parse(xml)).not.toThrow();
  });

  it("parses with multiple episodes", () => {
    const config = buildValidConfig();
    const meta = [
      makeEpisodeMeta({ guid: "ep1" }),
      makeEpisodeMeta({ guid: "ep2", url: "https://example.com/episodes/ep2.mp3" }),
    ];
    const xml = buildFeedXml(config, meta);
    expect(() => xmlParser.parse(xml)).not.toThrow();
  });
});

describe("buildFeedXml — determinism (no Date.now())", () => {
  it("pubDate from config serializes to the exact config date, not the current wall-clock date", () => {
    const config = buildValidConfig();
    const xml = buildFeedXml(config, [makeEpisodeMeta({ pubDate: "2026-06-01T00:00:00Z" })]);
    // Must contain the day-specific string "01 Jun 2026" — not just any June 2026 date.
    // This guards against Date.now() producing a correct-year-but-wrong-day value.
    expect(xml).toContain("01 Jun 2026");
  });
});
