import type { SoundstageElement } from "../jsx-runtime/index.js";

// Inheritable voice defaults — may appear on Episode and Segment
export interface VoiceDefaults {
  voice?: string;
  provider?: string;
  speed?: number;
}

// §4.1 Component prop types

export interface EpisodeProps extends VoiceDefaults {
  title: string;
  author?: string;
  artwork?: string;
  sampleRate?: number;
  /** Output channel count: 1 = mono (default), 2 = stereo. */
  channels?: 1 | 2;
  children?: SoundstageElement | SoundstageElement[];
}

export interface SegmentProps extends VoiceDefaults {
  title?: string;
  children?: SoundstageElement | SoundstageElement[];
}

export interface VoiceProps {
  voice?: string;      // required but may be inherited; validated after inheritance
  provider?: string;
  speed?: number;
  /** Stereo pan position: -1.0 (full left) to 1.0 (full right). Default 0.0 (center). */
  pan?: number;
  children?: string | string[];
}

export interface MusicBedProps {
  src: string;
  duck?: number;       // default -12 dB
  fadeIn?: number;
  fadeOut?: number;
  loop?: boolean;
  /** Stereo pan position: -1.0 (full left) to 1.0 (full right). Default 0.0 (center). */
  pan?: number;
  children?: SoundstageElement | SoundstageElement[];
}

export interface ClipProps {
  src: string;
  gain?: number;
  trim?: { start: number; end: number };
  /** Stereo pan position: -1.0 (full left) to 1.0 (full right). Default 0.0 (center). */
  pan?: number;
}

export interface SilenceProps {
  duration: number;   // seconds
}

export interface CrossfadeProps {
  duration?: number;  // seconds; default 0.75
}

// Component name constants — used as type discriminants in the element tree
export const COMPONENT_NAMES = {
  Episode: "Episode",
  Segment: "Segment",
  Voice: "Voice",
  MusicBed: "MusicBed",
  Clip: "Clip",
  Silence: "Silence",
  Crossfade: "Crossfade",
} as const;

export type ComponentName = (typeof COMPONENT_NAMES)[keyof typeof COMPONENT_NAMES];
