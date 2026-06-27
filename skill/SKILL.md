---
name: soundstage
description: Compile narrated audio episodes from JSX/TSX to WAV/mp3 with chapters, ducking, and loudness normalization.
triggers:
  - "render a podcast episode"
  - "narrated audio from script"
  - "changelog episode"
  - "daily briefing audio"
  - "audio as code"
  - "TTS + music bed"
  - "soundstage render"
---

# Soundstage — Agent Usage Guide

## When to use Soundstage

**Use Soundstage when:**
- You need **recurring or templated audio** (changelog episodes, daily briefings, CI-triggered reports) — the content-hash cache means only changed segments re-synthesize.
- You need **composition**: music beds, crossfades, sidechain ducking, EBU R128 loudness, navigable mp3 chapters — assembled correctly from code, not hand-written `filter_complex`.
- You want a **WAV master that is byte-identical** across runs given the same cache and pinned ffmpeg — the cache IS the determinism boundary (see Mental Model).
- You need **zero API keys** for a local default — Kokoro runs fully offline.

**Do NOT use Soundstage when:**
- You need a **one-off TTS clip** with no structure — call your TTS provider directly (ElevenLabs, OpenAI) and skip the composition layer.
- You need to **edit recorded audio** (interviews, field recordings) — use a DAW (GarageBand, Audacity, Descript) or post-production service (Auphonic).
- You need **real-time or streaming audio** — Soundstage is a batch renderer, not a streaming pipeline.

---

## 5-line mental model

1. A `.tsx` file describes your episode as a component tree: `<Episode>` → `<Segment>` → `<Voice>`.
2. Every `<Voice>` text block is a **cache unit**: synthesized once, stored by content hash, reused forever.
3. **The cache is the determinism boundary** — downstream of the cache (IR → ffmpeg → loudnorm → encode) is deterministic; upstream (first synthesis) is provider-dependent.
4. The compiler emits a correct `filter_complex` graph: resampling, sample-accurate placement, crossfades, sidechain ducking — none of which you hand-write.
5. The result is a **byte-identical WAV master** (from the same cache + pinned ffmpeg) plus an mp3 with navigable CHAP/CTOC chapters.

---

## Recipes

### 1. Changelog episode

```tsx
/** @jsxImportSource soundstage */

export default (
  <Episode title="Grafex Weekly #12" author="Grafex">
    <MusicBed src="./assets/theme.wav" duck={-12}>
      <Segment title="Intro">
        <Voice voice="af_heart">Welcome to Grafex Weekly. This week we shipped three improvements.</Voice>
      </Segment>
      <Crossfade duration={0.4} />
      <Segment title="What's New">
        <Voice voice="af_heart">Render times dropped forty percent. The new diff view makes code review faster.</Voice>
      </Segment>
      <Crossfade duration={0.4} />
      <Segment title="Outro">
        <Voice voice="af_heart">That's all for this week. Star us on GitHub and we'll see you next time.</Voice>
      </Segment>
    </MusicBed>
  </Episode>
);
```

```sh
npx soundstage render examples/changelog.tsx --final
# → changelog.wav (byte-identical WAV master)
# → changelog.mp3 (navigable chapters: Intro / What's New / Outro)
```

### 2. CI / cron daily briefing (GitHub Actions)

```yml
# .github/workflows/briefing.yml
- name: Render daily briefing
  run: npx soundstage render briefing.tsx --final
  env:
    # No keys needed for Kokoro (local, offline)
    NODE_ENV: production
```

```tsx
/** @jsxImportSource soundstage */
// briefing.tsx — generated from a script that fetches today's data

export default (
  <Episode title={`Daily Briefing — ${new Date().toDateString()}`}>
    <Segment title="Headlines">
      <Voice voice="af_heart">{headlines}</Voice>
    </Segment>
    <Segment title="Summary">
      <Voice voice="af_heart">{summary}</Voice>
    </Segment>
  </Episode>
);
```

### 3. Stereo output with per-voice pan

Add `channels={2}` to `<Episode>` to enable stereo output. Then use the `pan` prop on any `<Voice>`, `<Clip>`, or `<MusicBed>` to position it in the stereo field:

```tsx
/** @jsxImportSource soundstage */

export default (
  <Episode title="Stereo Interview" channels={2}>
    <Voice voice="am_adam" pan={-0.3}>So tell me about your experience.</Voice>
    <Voice voice="af_heart" pan={0.3}>It all started with a single changelog episode.</Voice>
  </Episode>
);
```

**Pan range:** `-1.0` = full left, `0.0` = center (default), `1.0` = full right. Uses constant-power law so perceived loudness stays even across the stereo field.

**Mono is the default and unchanged.** Episodes without `channels={2}` render exactly as before — no migration required.

**Phase 2 limitation:** stereo source files (a stereo bed WAV) are downmixed to mono by the input conditioning, then re-expanded via the pan filter. Native stereo width is not preserved.

### 4. Per-clip EQ and compression

Use `eq` and `compress` props on `<Voice>` or `<Clip>` to apply compile-time audio effects. Effects are applied after gain and pan — in declaration order — and do **not** affect the TTS cache.

```tsx
/** @jsxImportSource soundstage */

export default (
  <Episode title="Polished Narration">
    {/* Gentle high-shelf cut at 8 kHz to reduce sibilance */}
    <Voice
      voice="am_adam"
      eq={[
        { frequency: 8000, gain: -4, width: 2 },   // 8 kHz shelf cut, 2-octave width
        { frequency: 200,  gain: -2, width: 1 },   // low-end tighten
      ]}
      compress={{ threshold: -18, ratio: 3, attack: 10, release: 150, knee: 6 }}
    >
      Welcome to the show. Today we explore audio as code.
    </Voice>

    {/* EQ on a file clip */}
    <Clip
      src="./assets/intro-sting.wav"
      eq={[{ frequency: 1000, gain: -6, width: 1 }]}
    />
  </Episode>
);
```

**`eq` fields:** `frequency` (Hz, > 0), `gain` (dB, positive = boost, negative = cut), `width` (octaves, > 0 — uses `width_type=o` in ffmpeg). Multiple bands cascade in array order.

**`compress` fields:** `threshold` (dBFS, converted to linear internally — e.g. `-18` = −18 dBFS), `ratio` (N:1, range [1, 20]), `attack` (ms, > 0), `release` (ms, > 0), `knee` (curve-smoothness factor in [1, 8], NOT dB — ffmpeg's native unit; default ~2.83, higher = softer knee). `makeup` is always 1 — use `gain` on the clip for level control.

**Cache:** `eq` and `compress` are compile-time transforms. They do not affect the TTS synthesis cache — changing them re-renders without re-synthesizing speech.

### 5. Dialogue with music bed

```tsx
/** @jsxImportSource soundstage */

export default (
  <Episode title="Interview: The Future of Audio">
    <MusicBed src="./assets/intro-music.wav" duck={-18} fadeIn={1.5} fadeOut={2}>
      <Segment title="Opening">
        <Voice voice="am_adam">So tell me — what got you started on this?</Voice>
        <Voice voice="af_heart">It started with a changelog that took three hours to produce manually.</Voice>
      </Segment>
    </MusicBed>
    <Segment title="Deep Dive">
      <Voice voice="am_adam">Walk me through how the cache works.</Voice>
      <Voice voice="af_heart">Every Voice block is hashed by its text and settings. Change one word, only that block re-synthesizes.</Voice>
    </Segment>
  </Episode>
);
```

### 8. Podcast RSS feed

Generate an Apple Podcasts-compliant RSS feed from rendered episodes:

```sh
npx soundstage feed --config soundstage-feed.json
# → feed.xml  (RSS 2.0 + itunes: + atom: namespaces)
```

**`soundstage-feed.json` — minimal example:**

```json
{
  "show": {
    "title": "My Podcast",
    "description": "A weekly show about audio as code.",
    "author": "André Silva",
    "email": "andre@example.com",
    "imageUrl": "https://example.com/cover.jpg",
    "category": "Technology",
    "language": "en-us",
    "baseUrl": "https://example.com/episodes/",
    "feedUrl": "https://example.com/feed.xml",
    "link": "https://example.com",
    "explicit": false
  },
  "episodes": [
    {
      "file": "./ep1.mp3",
      "title": "Episode 1: Hello World",
      "description": "The first episode.",
      "pubDate": "2026-06-01T00:00:00Z",
      "guid": "ep1-2026-06-01",
      "explicit": false
    }
  ]
}
```

**Key invariants:**
- `pubDate` is always from config — never wall-clock. Feed output is reproducible given the same config + mp3.
- `show.category` must be from the Apple Podcasts taxonomy (validated at config-read time; `Technology`, `True Crime`, `Society & Culture`, etc.).
- `show.email` is optional but omitting it blocks Apple Podcasts submission (a warning is printed to stderr).
- `enclosure url = show.baseUrl + basename(episode.file)` — the `baseUrl` is normalized to end with `/`.
- Write to a custom directory: `npx soundstage feed --config soundstage-feed.json --out ./dist`.

---

## What the compiler absorbs (don't hand-write these)

- `aresample=48000` + `aformat` on every input edge — prevents sample-rate mismatch crashes
- `atrim` + `adelay` in samples — sample-accurate placement, no float rounding
- `acrossfade` with correct overlap math — crossfade duration subtracted from cursor
- `asplit` → `sidechaincompress` → `amix normalize=0` — correct sidechain ducking topology
- Two-pass EBU R128 loudnorm (`-16 LUFS / -1.5 dBTP / LRA 11`) as a **separate post-mix pass** — never in-graph
- `node-id3` CHAP + CTOC post-pass — ffmpeg omits CTOC (#7940); Soundstage writes it explicitly

---

### 6. Subtitle and transcript export

Add `--transcript` to generate `.srt`, `.vtt`, and `.txt` subtitle/transcript files:

```sh
npx soundstage render episode.tsx --final --transcript
# → episode.wav, episode.mp3 (as usual)
# → episode.srt              (SubRip subtitles — for video players, Premiere, etc.)
# → episode.vtt              (WebVTT subtitles — for browsers, YouTube captions)
# → episode.txt              (plain-text transcript — for show notes, SEO)
```

Cue text is the **original authored text** from each `<Voice>` block — exactly what you wrote, sentence by sentence. Timing comes from the per-sentence chunk positions in the IR (Phase 2 T7 sentence segmentation), so cues are sentence-granular, not word-granular.

`--transcript` is composable with `--player`:

```sh
npx soundstage render episode.tsx --final --transcript --player
# → all five artifacts generated in one pass
```

The transcript pass is pure text (no ffmpeg, no network) and always regenerates on a streaming skip.

### 7. Interactive HTML player with waveform

Add `--player` to generate a self-contained HTML player alongside your episode files:

```sh
npx soundstage render episode.tsx --final --player
# → episode.wav, episode.mp3 (as usual)
# → waveform.png             (1200×120 px peak waveform, steelblue)
# → episode-player.html      (open in browser to play with chapter buttons)
```

The HTML file is fully self-contained — waveform is base64-inlined, JS/CSS are inlined, no CDN. The mp3 is referenced by relative filename so they must stay in the same directory. Chapter buttons jump to the correct position using pre-computed timestamps (`startSample / sampleRate` as a literal float).

### 8. Cloud TTS provider (OpenAI)

```sh
export OPENAI_API_KEY=sk-...
npx soundstage render episode.tsx --final --provider openai
```

- `--provider openai` selects the OpenAI TTS adapter instead of the default (Kokoro).
- API key is read from `OPENAI_API_KEY` at render time — never pass it as a flag.
- The default OpenAI model is `tts-1`. For higher quality: use the `model` constructor option (library usage only — CLI always uses `tts-1`).
- Voice prop value is the OpenAI voice name: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`.
- ElevenLabs: `--provider elevenlabs` with `ELEVENLABS_API_KEY`; voice prop is the voice UUID.
- `--draft --provider openai` is silently ignored (synthetic adapter always wins with `--draft`).

---

## Cost guidance

| Mode | Command | When |
|---|---|---|
| **Draft** (synthetic tones, free, instant) | `--draft` | Development, CI, layout testing |
| **Final** (real Kokoro voice, local, free) | `--final` | Production render, no API cost |
| **Final, cloud TTS** (OpenAI / ElevenLabs) | `--final --provider openai` | When Kokoro voice quality isn't sufficient |

**Cache economics:** Edit one `<Voice>` → only that segment re-synthesizes. The cache report after each run shows exactly which segments were cached vs. re-synthesized:

```
soundstage: cache report
  Intro: 1/1 cached
  What's New: 1/1 re-synth  ← you edited this segment
  Outro: 1/1 cached
  total: 2/3 cached, 1 re-synth
```

A typical 3-segment episode: ~$0.00 per re-render after the first run (Kokoro is local). Cloud TTS: cost scales with the number of re-synthesized characters, not total episode length.

---

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `E_MISSING_PROP: voice` | `<Voice>` has no `voice` prop and none is inherited from `<Segment>`/`<Episode>` | Add `voice="af_heart"` to the `<Voice>` or inherit from parent |
| `E_SRC_NOT_FOUND` | `<MusicBed src="...">` path doesn't exist | Use a path relative to the `.tsx` file; run from the project root |
| `E_ADAPTER_MISSING_KEY` | Cloud TTS API key not set | `export OPENAI_API_KEY=sk-...` or `export ELEVENLABS_API_KEY=...` before rendering |
| Mix step fails (ffmpeg error) | Missing `ffmpeg`/`ffprobe` on PATH | Install ffmpeg v8.x: `brew install ffmpeg` / `apt install ffmpeg` |
| Kokoro model not found | First run downloads ~86 MB model | Wait for download; subsequent runs use the cached model |

**Never claim:** "reproducible voices." The WAV master is byte-identical from the same cache + pinned ffmpeg — that is the determinism guarantee. First synthesis of a new `<Voice>` block depends on the TTS provider and is not promised to be cross-machine reproducible; once cached, that audio is frozen.
