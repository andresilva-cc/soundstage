// Variant of simple.tsx with an edited first Voice — used by streaming tests
// to verify that a narration change changes the IR hash and triggers a re-render.
import { jsx, jsxs } from "soundstage/jsx-runtime";

const voice0 = jsx("Voice", { voice: "host", children: "Hello edited world." }, undefined);
const segment0 = jsx("Segment", { title: "Intro" }, undefined, voice0);

const voice1 = jsx("Voice", { voice: "host", children: "Goodbye world." }, undefined);
const segment1 = jsx("Segment", { title: "Outro" }, undefined, voice1);

export default jsxs("Episode", { title: "Simple Test Episode", children: [segment0, segment1] }, undefined);
