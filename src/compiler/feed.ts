// Podcast RSS feed generator — RSS 2.0 + Apple itunes: namespace.
// §6: soundstage feed subcommand + soundstage-feed.json config.
//
// DETERMINISM INVARIANT: pubDate ALWAYS comes from config (ISO 8601 → RFC 822).
// Date.now() is NEVER called in this module.

import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Apple Podcasts category taxonomy — parent → subcategories map.
// Top-level categories have an empty subcategory array.
// Source: https://podcasters.apple.com/support/1691-apple-podcasts-categories
// ---------------------------------------------------------------------------

export const ITUNES_CATEGORY_MAP: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["Arts", ["Books", "Design", "Fashion & Beauty", "Food", "Performing Arts", "Visual Arts"]],
  ["Business", ["Careers", "Entrepreneurship", "Investing", "Management", "Marketing", "Non-Profit"]],
  ["Comedy", ["Comedy Interviews", "Improv", "Stand-Up"]],
  ["Education", ["Courses", "How To", "Language Learning", "Self-Improvement"]],
  ["Fiction", ["Comedy Fiction", "Drama", "Science Fiction"]],
  ["Government", []],
  ["History", []],
  ["Health & Fitness", ["Alternative Health", "Fitness", "Medicine", "Mental Health", "Nutrition", "Sexuality"]],
  ["Kids & Family", ["Education for Kids", "Parenting", "Pets & Animals", "Stories for Kids"]],
  ["Leisure", ["Animation & Manga", "Automotive", "Aviation", "Crafts", "Games", "Hobbies", "Home & Garden", "Video Games"]],
  ["Music", ["Music Commentary", "Music History", "Music Interviews"]],
  ["News", ["Business News", "Daily News", "Entertainment News", "News Commentary", "Politics", "Sports News", "Tech News"]],
  ["Religion & Spirituality", ["Buddhism", "Christianity", "Hinduism", "Islam", "Judaism", "Religion", "Spirituality"]],
  ["Science", ["Astronomy", "Chemistry", "Earth Sciences", "Life Sciences", "Mathematics", "Natural Sciences", "Nature", "Physics", "Social Sciences"]],
  ["Society & Culture", ["Documentary", "Personal Journals", "Philosophy", "Places & Travel", "Relationships"]],
  ["Sports", ["Baseball", "Basketball", "Cricket", "Fantasy Sports", "Football", "Golf", "Hockey", "Rugby", "Soccer", "Swimming", "Tennis", "Volleyball", "Wilderness", "Wrestling"]],
  ["Technology", []],
  ["True Crime", []],
  ["TV & Film", ["After Shows", "Film History", "Film Interviews", "Film Reviews", "TV Reviews"]],
]);

// Flat set of all valid category and subcategory strings — for O(1) membership test.
export const ITUNES_CATEGORIES: ReadonlySet<string> = new Set([
  ...ITUNES_CATEGORY_MAP.keys(),
  ...[...ITUNES_CATEGORY_MAP.values()].flat(),
]);

// Reverse map: subcategory → parent category (for nested XML emission).
const ITUNES_SUBCATEGORY_PARENT: ReadonlyMap<string, string> = new Map(
  [...ITUNES_CATEGORY_MAP.entries()].flatMap(([parent, subs]) =>
    subs.map(sub => [sub, parent] as [string, string]),
  ),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShowConfig {
  title: string;
  description: string;
  author: string;
  email?: string;
  imageUrl: string;
  category: string;
  language: string;
  baseUrl: string;
  feedUrl: string;
  link?: string;
  explicit?: boolean;
}

export interface EpisodeConfig {
  file: string;
  title: string;
  description?: string;
  pubDate: string;
  guid: string;
  explicit?: boolean;
}

export interface FeedConfig {
  show: ShowConfig;
  episodes: EpisodeConfig[];
}

export interface EpisodeMeta {
  guid: string;
  title: string;
  description?: string;
  pubDate: string;
  url: string;
  byteSize: number;
  durationSeconds: number;
  explicit?: boolean;
}

// ---------------------------------------------------------------------------
// validateFeedConfig
// ---------------------------------------------------------------------------

function requireShowField(show: Record<string, unknown>, field: string): string {
  const value = show[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`soundstage feed: missing required show field: ${field}`);
  }
  return value;
}

export function validateFeedConfig(raw: unknown): FeedConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("soundstage feed: config must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  // Validate show
  if (typeof obj.show !== "object" || obj.show === null) {
    throw new Error("soundstage feed: missing required field: show");
  }
  const show = obj.show as Record<string, unknown>;

  const title = requireShowField(show, "title");
  const description = requireShowField(show, "description");
  const author = requireShowField(show, "author");
  const imageUrl = requireShowField(show, "imageUrl");
  const category = requireShowField(show, "category");
  const language = requireShowField(show, "language");
  const feedUrl = requireShowField(show, "feedUrl");
  let baseUrl = requireShowField(show, "baseUrl");

  // M4: Normalize baseUrl — append trailing slash if missing
  if (!baseUrl.endsWith("/")) {
    baseUrl = baseUrl + "/";
  }

  // H1: Validate category against Apple Podcasts taxonomy
  if (!ITUNES_CATEGORIES.has(category)) {
    const validList = [...ITUNES_CATEGORIES].sort().join(", ");
    throw new Error(
      `soundstage feed: show.category "${category}" is not in the Apple Podcasts taxonomy. Valid categories: ${validList}`,
    );
  }

  // Email: optional but strongly recommended — warn if absent
  const emailValue = typeof show.email === "string" && show.email.trim() !== "" ? show.email : undefined;
  if (emailValue === undefined) {
    process.stderr.write(
      "soundstage feed: warning: show.email is not set. This blocks Apple Podcasts submission. " +
        "Add an email field to your soundstage-feed.json show config.\n",
    );
  }

  const link = typeof show.link === "string" && show.link.trim() !== "" ? show.link : baseUrl;
  const explicit = typeof show.explicit === "boolean" ? show.explicit : false;

  // Validate episodes
  if (!Array.isArray(obj.episodes)) {
    throw new Error("soundstage feed: missing required field: episodes (must be an array)");
  }

  const episodes: EpisodeConfig[] = (obj.episodes as unknown[]).map((ep, i) => {
    if (typeof ep !== "object" || ep === null) {
      throw new Error(`soundstage feed: episode[${i}] must be an object`);
    }
    const e = ep as Record<string, unknown>;

    for (const field of ["file", "title", "pubDate", "guid"] as const) {
      if (typeof e[field] !== "string" || (e[field] as string).trim() === "") {
        throw new Error(`soundstage feed: episode[${i}] missing required field: ${field}`);
      }
    }

    const pubDate = e.pubDate as string;
    if (isNaN(new Date(pubDate).getTime())) {
      throw new Error(
        `soundstage feed: episode[${i}] pubDate "${pubDate}" is not a valid date (expected ISO 8601, e.g. "2026-06-01T00:00:00Z")`,
      );
    }

    const episodeResult: EpisodeConfig = {
      file: e.file as string,
      title: e.title as string,
      pubDate,
      guid: e.guid as string,
    };
    if (typeof e.description === "string") episodeResult.description = e.description;
    if (typeof e.explicit === "boolean") episodeResult.explicit = e.explicit;
    return episodeResult;
  });

  // Duplicate GUID detection
  const seenGuids = new Set<string>();
  for (const ep of episodes) {
    if (seenGuids.has(ep.guid)) {
      throw new Error(`soundstage feed: duplicate episode guid "${ep.guid}" — each episode must have a unique guid`);
    }
    seenGuids.add(ep.guid);
  }

  const showResult: ShowConfig = {
    title,
    description,
    author,
    imageUrl,
    category,
    language,
    baseUrl,
    feedUrl,
    link,
    explicit,
  };
  if (emailValue !== undefined) showResult.email = emailValue;

  return {
    show: showResult,
    episodes,
  };
}

// ---------------------------------------------------------------------------
// xmlEscape — escapes & < > " ' for XML text and attribute content
// ---------------------------------------------------------------------------

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// secondsToHms — converts integer seconds to "HH:MM:SS"
// ---------------------------------------------------------------------------

export function secondsToHms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
}

// ---------------------------------------------------------------------------
// buildFeedXml — pure function, no I/O
// ---------------------------------------------------------------------------

export function buildFeedXml(config: FeedConfig, episodeMeta: EpisodeMeta[]): string {
  const { show } = config;

  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<rss version="2.0"` +
    ` xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"` +
    ` xmlns:atom="http://www.w3.org/2005/Atom">`,
  );
  lines.push("  <channel>");
  lines.push(`    <title>${xmlEscape(show.title)}</title>`);
  lines.push(`    <link>${xmlEscape(show.link ?? show.baseUrl)}</link>`);
  lines.push(`    <description>${xmlEscape(show.description)}</description>`);
  lines.push(`    <language>${xmlEscape(show.language)}</language>`);
  lines.push(
    `    <atom:link href="${xmlEscape(show.feedUrl)}" rel="self" type="application/rss+xml"/>`,
  );
  lines.push(`    <itunes:author>${xmlEscape(show.author)}</itunes:author>`);
  lines.push(`    <itunes:image href="${xmlEscape(show.imageUrl)}"/>`);
  // Emit category: nested form for subcategories, flat for top-level.
  const categoryParent = ITUNES_SUBCATEGORY_PARENT.get(show.category);
  if (categoryParent !== undefined) {
    // Subcategory: <itunes:category text="Parent"><itunes:category text="Sub"/></itunes:category>
    lines.push(`    <itunes:category text="${xmlEscape(categoryParent)}"><itunes:category text="${xmlEscape(show.category)}"/></itunes:category>`);
  } else {
    // Top-level category: flat form
    lines.push(`    <itunes:category text="${xmlEscape(show.category)}"/>`);
  }

  // H3: itunes:owner — only when email is present
  if (show.email !== undefined) {
    lines.push(`    <itunes:owner><itunes:name>${xmlEscape(show.author)}</itunes:name><itunes:email>${xmlEscape(show.email)}</itunes:email></itunes:owner>`);
  }

  // H3: channel-level itunes:explicit — always "true" or "false" (never boolean)
  lines.push(`    <itunes:explicit>${show.explicit === true ? "true" : "false"}</itunes:explicit>`);

  // Items — one per episode, in config order
  for (const meta of episodeMeta) {
    const episodeExplicit = meta.explicit === true ? "true" : "false";
    const enclosureUrl = meta.url.startsWith("http")
      ? meta.url
      : show.baseUrl + basename(meta.url);

    // pubDate: ISO 8601 → RFC 822 via new Date().toUTCString() — never Date.now()
    const pubDateRfc822 = new Date(meta.pubDate).toUTCString();

    lines.push("    <item>");
    lines.push(`      <title>${xmlEscape(meta.title)}</title>`);
    lines.push(`      <guid isPermaLink="false">${xmlEscape(meta.guid)}</guid>`);
    lines.push(`      <pubDate>${pubDateRfc822}</pubDate>`);
    if (meta.description !== undefined) {
      lines.push(`      <description>${xmlEscape(meta.description)}</description>`);
    }
    lines.push(
      `      <enclosure url="${xmlEscape(enclosureUrl)}" length="${meta.byteSize}" type="audio/mpeg"/>`,
    );
    lines.push(`      <itunes:duration>${secondsToHms(meta.durationSeconds)}</itunes:duration>`);
    lines.push(`      <itunes:explicit>${episodeExplicit}</itunes:explicit>`);
    lines.push("    </item>");
  }

  lines.push("  </channel>");
  lines.push("</rss>");

  return lines.join("\n") + "\n";
}
