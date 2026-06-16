# Soundstage

**Audio as Code** — compose narrated audio episodes with JSX/TSX, render to WAV/mp3 with chapters, sidechain-ducked music beds, and EBU R128 loudness normalization. No DAW required.

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
# → changelog.wav  (byte-identical WAV master, EBU R128 normalized)
# → changelog.mp3  (navigable chapters: Intro / What's New / Outro)
```

## Quick start

```sh
# Prerequisites: Node.js ≥ 20, ffmpeg v8.x on PATH
npx soundstage render examples/changelog.tsx --draft   # synthetic voices — instant, no install
npm install kokoro-js                                  # optional: enables the real voice
npx soundstage render examples/changelog.tsx           # real Kokoro voice (default; downloads ~86 MB model on first run)
```

The real voice is powered by [`kokoro-js`](https://www.npmjs.com/package/kokoro-js), an **optional** dependency. Install it for production audio, or use `--draft` for an instant synthetic preview that needs no download. Run the voiced default without it and Soundstage prints a one-line hint on how to enable it.

Edit one `<Voice>` block and re-run — only that segment re-synthesizes. The cache report shows exactly what changed:

```
soundstage: cache report
  Intro: 1/1 cached
  What's New: 1/1 re-synth
  Outro: 1/1 cached
  total: 2/3 cached, 1 re-synth
```

## Determinism

Given the **same cache** and a **pinned ffmpeg version**, Soundstage produces a **byte-identical WAV master**. The content-hash cache is both the determinism boundary and the cost mechanism — an edit re-synthesizes only the changed `<Voice>` segment, not the whole episode.

## Components

| Component | Purpose |
|---|---|
| `<Episode>` | Root; sets title, author, artwork, sample rate |
| `<Segment>` | Logical chapter; becomes a navigable mp3 chapter |
| `<Voice>` | The cached unit — one TTS call, one cache entry |
| `<MusicBed>` | Plays under children; sidechain-ducked |
| `<Clip>` | Mixes in an existing audio file |
| `<Silence>` | Inserts an exact-duration gap |
| `<Crossfade>` | Crossfades between two sibling clips |

## Prerequisites

- Node.js ≥ 20
- ffmpeg/ffprobe v8.x on PATH (`brew install ffmpeg` / `apt install ffmpeg`)
- **Real voices (optional):** the [`kokoro-js`](https://www.npmjs.com/package/kokoro-js) package (`npm install kokoro-js`). Skip it and pass `--draft` for synthetic voices that need no model download.

## License

MIT
