// Simple two-segment episode fixture for CLI integration tests.
// Uses explicit jsx() calls so tsc can typecheck this without JSX intrinsic element types.
import { jsx, jsxs } from "soundstage/jsx-runtime";

const voice0 = jsx("Voice", { voice: "host", children: "Hello world." }, undefined);
const segment0 = jsx("Segment", { title: "Intro" }, undefined, voice0);

const voice1 = jsx("Voice", { voice: "host", children: "Goodbye world." }, undefined);
const segment1 = jsx("Segment", { title: "Outro" }, undefined, voice1);

export default jsxs("Episode", { title: "Simple Test Episode", children: [segment0, segment1] }, undefined);
