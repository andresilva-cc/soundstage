/**
 * Bumping this constant invalidates the entire cache.
 * v2: added `loop?: boolean` to ClipIR (T7, Phase B) — T8b realizes it via `aloop` in ffmpeg.
 * v3: added `channels: 1 | 2` to IR; added `pan?: number` to ClipIR (T3, Phase 2).
 */
export const SCHEMA_VERSION = 3;
