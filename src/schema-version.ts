/**
 * Bump this when the cache key derivation changes or when an IR field changes
 * in a non-additive way (rename, removal, type narrowing). Additive optional
 * fields (e.g. `effects`, `pan`, `fades`) do NOT require a bump.
 *
 * v2: added `loop?: boolean` to ClipIR (T7, Phase B) — T8b realizes it via `aloop` in ffmpeg.
 * v3: added `channels: 1 | 2` to IR; added `pan?: number` to ClipIR (T3, Phase 2).
 * Note: T5 added `effects?: ClipEffect[]` to ClipIR without a bump — additive optional field.
 * v4: auto text segmentation (T7, Phase 2) — chunk text replaces full Voice text as the hashed
 *     `text` field in the cache key. All v3 entries are invalidated; v4 entries use per-chunk keys.
 */
export const SCHEMA_VERSION = 4;
