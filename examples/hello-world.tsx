/** @jsxImportSource soundstage */
import { Episode, Voice, MusicBed } from "soundstage";

export default (
  <Episode title="Hello, World" author="Soundstage">
    <MusicBed src="./assets/bed.wav" duck={-12}>
      <Voice voice="af_heart">Hello, world.</Voice>
      <Voice voice="af_heart">This was written entirely in code.</Voice>
      <Voice voice="af_heart">No microphone. No studio. Just JSX.</Voice>
    </MusicBed>
  </Episode>
);
