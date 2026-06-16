// §4.5 — Cache key derivation.
// key = sha256( canonicalJSON({ schemaVersion, adapterId, model, voice, settings, text, format }) )
// All case-bearing components are lowercased before hashing.
// The result is lowercase hex (64 chars) — APFS case-insensitivity safe.

import { createHash } from "node:crypto";
import { canonicalJSON, normalizeText } from "./canonical.js";
import type { TtsAdapter, SynthRequest } from "../types.js";
import { SCHEMA_VERSION } from "../../schema-version.js";

export { SCHEMA_VERSION };

export interface CacheKeyInput {
  schemaVersion: number;
  adapterId: string;
  model: string;
  voice: string;
  settings: Record<string, unknown>;
  text: string;
  format: {
    sampleRate: number;
    sampleFmt: string;
    channels: number;
  };
}

/**
 * Derive a deterministic cache key for the given request + adapter combination.
 * Returns a 64-character lowercase hex string (SHA-256).
 */
export function deriveKey(req: SynthRequest, adapter: TtsAdapter): string {
  const normalizedText = normalizeText(req.text);

  // Lowercase all case-bearing components before hashing (APFS case-insensitivity safety).
  // Pass the lowercased voice to canonicalSettings so the settings object is also case-normalized.
  const normalizedVoice = req.voice.toLowerCase();
  const normalizedReq: typeof req = { ...req, text: normalizedText, voice: normalizedVoice };

  const input: CacheKeyInput = {
    schemaVersion: SCHEMA_VERSION,
    adapterId: adapter.id.toLowerCase(),
    model: adapter.model.toLowerCase(),
    voice: normalizedVoice,
    settings: adapter.canonicalSettings(normalizedReq),
    text: normalizedText,
    format: {
      sampleRate: req.sampleRate,
      sampleFmt: "f32le",
      channels: 1,
    },
  };

  const json = canonicalJSON(input);
  return createHash("sha256").update(json, "utf8").digest("hex");
}
