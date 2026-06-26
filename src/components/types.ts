import type { SoundstageElement } from "../jsx-runtime/index.js";

// Inheritable voice defaults — may appear on Episode and Segment
export interface VoiceDefaults {
  voice?: string;
  provider?: string;
  speed?: number;
}

// §4.1 Component prop types

export interface EqBand {
  frequency: number;  // Hz, > 0
  gain: number;       // dB, finite
  width: number;      // Q in octaves, > 0
}

export interface CompressProps {
  threshold: number;  // dBFS (user-facing); compiler converts to linear for ffmpeg
  ratio: number;      // N:1, range [1, 20]
  attack: number;     // ms, range [0.01, 2000]
  release: number;    // ms, range [0.01, 9000]
  knee: number;       // curve-smoothness factor, ffmpeg native range [1, 8] (default ~2.83)
}

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
  /** EQ bands applied to this clip's audio, in declaration order. */
  eq?: EqBand[];
  /** Compression applied to this clip's audio. */
  compress?: CompressProps;
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
  /** EQ bands applied to this clip's audio, in declaration order. */
  eq?: EqBand[];
  /** Compression applied to this clip's audio. */
  compress?: CompressProps;
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
