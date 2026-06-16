// ir — validation, inheritance resolution, and Phase A/B.
// resolveInheritance is intentionally NOT re-exported here (T6 hardening):
// validateTree is the sole public resolve+validate entry point.
// Import resolveInheritance directly from "./inherit.js" for unit tests only.
export { validateTree } from "./validate.js";
export { phaseA } from "./phase-a.js";
export type { SourceRef, SourceRefCache, SourceRefFile, PhaseAOptions } from "./phase-a.js";
export { SoundstageError } from "./errors.js";
export type { ErrorCode } from "./errors.js";
