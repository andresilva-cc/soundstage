import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SoundstageElement } from "../jsx-runtime/index.js";
import { COMPONENT_NAMES } from "../components/types.js";
import { SoundstageError, formatPath } from "./errors.js";
import { resolveInheritance } from "./inherit.js";
import type { IR } from "./phase-b.js";

const MAX_DEPTH = 100;

// Required props per component (post-inheritance for Voice)
const REQUIRED_PROPS: Record<string, string[]> = {
  [COMPONENT_NAMES.Episode]: ["title"],
  [COMPONENT_NAMES.Voice]: ["voice"],
  [COMPONENT_NAMES.MusicBed]: ["src"],
  [COMPONENT_NAMES.Clip]: ["src"],
  [COMPONENT_NAMES.Silence]: ["duration"],
};

// Props that reference filesystem paths
const SRC_PROPS: Record<string, string[]> = {
  [COMPONENT_NAMES.MusicBed]: ["src"],
  [COMPONENT_NAMES.Clip]: ["src"],
};

// Audio-producing node types valid as Crossfade neighbors.
// Segment is included because it contains audio children; a crossfade between
// two Segments blends the last clip of one with the first clip of the other.
const AUDIO_SIBLING_TYPES = new Set([
  COMPONENT_NAMES.Voice,
  COMPONENT_NAMES.Clip,
  COMPONENT_NAMES.Silence,
  COMPONENT_NAMES.Segment,
]);

function describeNode(node: SoundstageElement): string {
  const typeName = node.type as string;
  const title = node.props["title"] as string | undefined;
  if (title !== undefined) {
    return `<${typeName} title="${title}">`;
  }
  const src = node.props["src"] as string | undefined;
  if (src !== undefined) {
    return `<${typeName} src="${src}">`;
  }
  return `<${typeName}>`;
}

function validateNode(
  node: SoundstageElement,
  pathParts: string[],
  baseDir: string,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    throw new SoundstageError(
      "E_MAX_DEPTH",
      `Tree exceeds maximum nesting depth of ${MAX_DEPTH}`,
      formatPath(pathParts),
    );
  }

  const typeName = typeof node.type === "string" ? node.type : undefined;
  if (typeName === undefined) return; // component functions — skip, not a named component

  const nodeDesc = describeNode(node);
  const nodePath = formatPath([...pathParts, nodeDesc]);

  // Check required props
  const required = REQUIRED_PROPS[typeName];
  if (required !== undefined) {
    for (const prop of required) {
      if (!(prop in node.props) || node.props[prop] === undefined || node.props[prop] === null) {
        throw new SoundstageError(
          "E_MISSING_PROP",
          `<${typeName}> is missing required prop "${prop}"`,
          nodePath,
        );
      }
    }
  }

  // Validate <Episode channels> when set: must be exactly 1 or 2 (integer).
  if (typeName === COMPONENT_NAMES.Episode) {
    const channels = node.props["channels"];
    if (channels !== undefined) {
      if (
        typeof channels !== "number" ||
        !Number.isFinite(channels) ||
        !Number.isInteger(channels) ||
        (channels !== 1 && channels !== 2)
      ) {
        throw new SoundstageError(
          "E_INVALID_PROP",
          `<Episode> channels must be 1 or 2, got ${JSON.stringify(channels)}`,
          nodePath,
        );
      }
    }
  }

  // Validate pan prop on <Voice>, <Clip>, <MusicBed> when set: finite number in [-1.0, 1.0].
  const PAN_PROP_TYPES: Set<string> = new Set([
    COMPONENT_NAMES.Voice,
    COMPONENT_NAMES.Clip,
    COMPONENT_NAMES.MusicBed,
  ]);
  if (PAN_PROP_TYPES.has(typeName)) {
    const pan = node.props["pan"];
    if (pan !== undefined) {
      if (typeof pan !== "number" || !Number.isFinite(pan) || pan < -1.0 || pan > 1.0) {
        throw new SoundstageError(
          "E_INVALID_PROP",
          `<${typeName}> pan must be a finite number in [-1.0, 1.0], got ${JSON.stringify(pan)}`,
          nodePath,
        );
      }
    }
  }

  // Check src path existence (resolve relative paths against baseDir)
  const srcProps = SRC_PROPS[typeName];
  if (srcProps !== undefined) {
    for (const prop of srcProps) {
      const src = node.props[prop] as string | undefined;
      if (src !== undefined) {
        const absPath = resolve(baseDir, src);
        if (!existsSync(absPath)) {
          throw new SoundstageError(
            "E_SRC_NOT_FOUND",
            `<${typeName}> src="${src}" does not exist on disk`,
            nodePath,
          );
        }
      }
    }
  }

  // Validate composition rules for children
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child === null || child === undefined || typeof child !== "object" || !("type" in child)) {
      continue;
    }
    const childEl = child as SoundstageElement;
    const childType = typeof childEl.type === "string" ? childEl.type : undefined;

    // E_CROSSFADE_BOUNDARY: <Crossfade> must have a preceding AND following audio sibling
    if (childType === COMPONENT_NAMES.Crossfade) {
      const hasPreceding = i > 0 && isAudioSibling(children[i - 1]);
      const hasFollowing = i < children.length - 1 && isAudioSibling(children[i + 1]);
      if (!hasPreceding || !hasFollowing) {
        const crossfadePath = formatPath([...pathParts, nodeDesc, `child index ${i}`]);
        throw new SoundstageError(
          "E_CROSSFADE_BOUNDARY",
          "<Crossfade> must sit between two audio siblings",
          crossfadePath,
        );
      }
    }

    // Recurse into child
    validateNode(childEl, [...pathParts, nodeDesc], baseDir, depth + 1);
  }
}

function isAudioSibling(child: unknown): boolean {
  if (child === null || child === undefined || typeof child !== "object" || !("type" in child)) {
    return false;
  }
  const el = child as SoundstageElement;
  const t = el.type;
  return typeof t === "string" && (AUDIO_SIBLING_TYPES as Set<string>).has(t);
}

/**
 * Extension point for IR-level validation before any ffmpeg invocation.
 * Currently a no-op: E_MULTI_BED_UNSUPPORTED was lifted in T4 and no new
 * IR-level constraints have been added. Per-bed invariants (e.g. single clip
 * per bed track) are enforced inside buildBedTrack() in ducking.ts.
 */
export function validateIR(_ir: IR): void {
  // No IR-level constraints currently enforced here.
}

/**
 * Phase A single entry point: resolve inheritance then validate the tree.
 * Returns the RESOLVED+VALIDATED tree (not the original input).
 * Callers (T6/T12) must use the returned tree — do NOT call resolveInheritance again on it.
 * Throws SoundstageError (E_MISSING_PROP, E_CROSSFADE_BOUNDARY, E_SRC_NOT_FOUND, E_MAX_DEPTH) on error.
 * Not pure — performs existsSync I/O to check src paths.
 * Idempotent: resolveInheritance is idempotent (Voice nodes' explicit effective props win),
 * so validateTree(validateTree(t)) yields a structurally equal tree.
 *
 * @param baseDir - Directory used to resolve relative src/artwork paths.
 *                  T6/T12 should pass the composition file's directory.
 *                  Defaults to process.cwd().
 */
export function validateTree(
  tree: SoundstageElement,
  baseDir: string = process.cwd(),
): SoundstageElement {
  const resolved = resolveInheritance(tree);
  validateNode(resolved, [], baseDir, 0);
  return resolved;
}
