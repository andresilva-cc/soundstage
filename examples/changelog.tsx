/** @jsxImportSource soundstage */
import { Episode, Segment, Voice, MusicBed, Crossfade } from "soundstage";

export default (
  <Episode title="Grafex Weekly #12" author="Grafex">
    <MusicBed src="./assets/theme.wav" duck={-12}>
      <Segment title="Intro">
        <Voice voice="af_heart">Welcome to Grafex Weekly. This week we shipped three improvements.</Voice>
      </Segment>
      <Crossfade duration={0.1} />
      <Segment title="What's New">
        <Voice voice="af_heart">Render times dropped forty percent. The new diff view makes code review faster.</Voice>
      </Segment>
      <Crossfade duration={0.1} />
      <Segment title="Outro">
        <Voice voice="af_heart">That's all for this week. Star us on GitHub and we'll see you next time.</Voice>
      </Segment>
    </MusicBed>
  </Episode>
);
