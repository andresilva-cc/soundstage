# Soundstage

**Audio as Code** — compose narrated audio episodes with JSX/TSX, render to WAV/mp3. No DAW required.

```tsx
import { Episode, Segment, Voice, MusicBed } from "soundstage";

export default (
  <Episode title="My Podcast #1">
    <MusicBed src="theme.mp3" duck={-12}>
      <Segment title="Intro">
        <Voice voice="af_heart">Welcome to the show.</Voice>
      </Segment>
    </MusicBed>
  </Episode>
);
```

```sh
npx soundstage render episode.tsx --final
```

> **Status:** v0.1 in development — the deterministic spine.

## Prerequisites

- Node.js ≥ 20
- ffmpeg/ffprobe v8.x on PATH

## License

MIT
