// Component name constants for use in JSX authoring files.
// In the soundstage JSX runtime, components are identified by their string name.
// Importing these lets .tsx files write <Episode> / <Voice> etc. without
// relying on JSX intrinsic element declarations (which this runtime doesn't use).
export { COMPONENT_NAMES as Components } from "./components/types.js";

// Re-export individual component name strings for direct destructuring:
//   import { Episode, Segment, Voice, MusicBed, Crossfade } from "soundstage";
export const Episode = "Episode" as const;
export const Segment = "Segment" as const;
export const Voice = "Voice" as const;
export const MusicBed = "MusicBed" as const;
export const Clip = "Clip" as const;
export const Silence = "Silence" as const;
export const Crossfade = "Crossfade" as const;
