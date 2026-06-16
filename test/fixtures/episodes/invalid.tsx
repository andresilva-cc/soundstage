// Invalid episode fixture: <Voice> is missing the required `voice` prop.
// Used to test E_MISSING_PROP error handling in CLI integration tests.
import { jsx } from "soundstage/jsx-runtime";

// Voice with no `voice` prop — should trigger E_MISSING_PROP validation error.
const voice = jsx("Voice", { children: "Missing voice prop." }, undefined);
const segment = jsx("Segment", { title: "Broken" }, undefined, voice);

export default jsx("Episode", { title: "Invalid Episode" }, undefined, segment);
