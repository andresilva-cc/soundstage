// Streaming / Partial Render — skip-unchanged detection.
// §T8: after Phase B and after ir.render.ffmpegVersion is set, hash the IR.
// If the hash matches the stored value AND all output files exist, the
// mix/loudnorm/encode/post-pass steps are skipped.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJSON } from "../adapters/cache/canonical.js";
import type { IR } from "../ir/phase-b.js";

// ---------------------------------------------------------------------------
// State file location — outDir/.soundstage/render-state.json
// ---------------------------------------------------------------------------

function renderStatePath(outDir: string): string {
  return join(outDir, ".soundstage", "render-state.json");
}

// ---------------------------------------------------------------------------
// State shape + guard
// ---------------------------------------------------------------------------

interface RenderState {
  ir_hash: string;
}

function isRenderState(value: unknown): value is RenderState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RenderState).ir_hash === "string"
  );
}

// ---------------------------------------------------------------------------
// Read — returns null on missing / corrupt file (no crash)
// ---------------------------------------------------------------------------

export async function readRenderState(outDir: string): Promise<RenderState | null> {
  try {
    const text = await readFile(renderStatePath(outDir), "utf8");
    const parsed: unknown = JSON.parse(text);
    return isRenderState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function writeRenderState(outDir: string, irHash: string): Promise<void> {
  const stateDir = join(outDir, ".soundstage");
  await mkdir(stateDir, { recursive: true });
  const state: RenderState = { ir_hash: irHash };
  await writeFile(renderStatePath(outDir), JSON.stringify(state, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Hash — MUST be called after ir.render.ffmpegVersion is set
// ---------------------------------------------------------------------------

/**
 * Compute the IR hash used for streaming skip detection.
 *
 * The hash MUST be computed after ir.render.ffmpegVersion is populated.
 * An ffmpeg binary upgrade changes the version string → different hash →
 * skip is correctly busted even when the composition text is unchanged.
 * This guards the determinism boundary: the same ffmpeg binary + same IR
 * always produces the same audio.
 */
export function hashIR(ir: IR): string {
  return createHash("sha256").update(canonicalJSON(ir), "utf8").digest("hex");
}
