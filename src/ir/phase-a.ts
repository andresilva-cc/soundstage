// Phase A — Resolve & Synthesize.
// §3.1: Walk the inheritance-resolved element tree; for each Voice node, call CacheLayer.get()
// (synthesizes on miss, hits on warm); for each Clip/MusicBed src, probe the real duration
// via ffprobe. Produce a resolved tree where every leaf has sourceRef + durationSamples.
//
// Phase A is the ONLY phase that touches TTS, cache, and ffprobe. Its output is a pure
// value that Phase B can lower without any I/O.
// Synthesis is SEQUENTIAL (no Promise.all) per §5.7.

import { resolve } from "node:path";
import type { SoundstageElement } from "../jsx-runtime/index.js";
import { COMPONENT_NAMES } from "../components/types.js";
import type { SynthRequest } from "../adapters/types.js";
import type { CacheLayer, CacheResult } from "../adapters/cache/index.js";
import { probeFileDuration } from "../probe/index.js";
import { validateTree } from "./validate.js";

export interface SourceRefCache {
  kind: "cache";
  path: string;
  hash: string;
  /** Stable tree-order id of the Voice node — used by Phase B for per-segment cache reporting. */
  voiceUnitId: number;
}

export interface SourceRefFile {
  kind: "file";
  path: string;
}

export type SourceRef = SourceRefCache | SourceRefFile;

export interface PhaseAOptions {
  cache: CacheLayer;
  baseDir: string;
}

/**
 * Recursively walk the resolved tree and resolve all leaves.
 * Synthesis is awaited sequentially in tree order.
 * voiceCounter is a mutable counter incremented for each Voice node in tree order.
 */
async function resolveNode(
  node: SoundstageElement,
  episodeSampleRate: number,
  options: PhaseAOptions,
  voiceCounter: { value: number },
  effectiveProvider?: string,
): Promise<SoundstageElement> {
  const typeName = typeof node.type === "string" ? node.type : undefined;

  // Voice node: synthesize via CacheLayer
  if (typeName === COMPONENT_NAMES.Voice) {
    const voice = node.props["voice"] as string;
    const speed = node.props["speed"] as number | undefined;
    const provider = node.props["provider"] as string | undefined;

    // Warn if the effective provider doesn't match the injected adapter
    const effectiveVoiceProvider = provider ?? effectiveProvider;
    if (effectiveVoiceProvider !== undefined && effectiveVoiceProvider !== options.cache.adapterId) {
      process.stderr.write(
        `soundstage: warning: Voice provider "${effectiveVoiceProvider}" does not match injected adapter "${options.cache.adapterId}" — using injected adapter\n`
      );
    }

    // Extract text from children
    const text = node.children
      .filter((c): c is string => typeof c === "string")
      .join("");

    const req: SynthRequest = {
      text,
      voice,
      sampleRate: episodeSampleRate,
      ...(speed !== undefined ? { speed } : {}),
    };

    const result: CacheResult = await options.cache.get(req);
    const voiceUnitId = voiceCounter.value++;

    const sourceRef: SourceRefCache = {
      kind: "cache",
      path: result.wavPath,
      hash: result.hash,
      voiceUnitId,
    };

    return {
      type: node.type,
      props: {
        ...node.props,
        sourceRef,
        durationSamples: result.durationSamples,
      },
      children: node.children,
    };
  }

  // Clip node: probe file duration
  if (typeName === COMPONENT_NAMES.Clip) {
    const src = node.props["src"] as string;
    const absPath = resolve(options.baseDir, src);
    const probed = await probeFileDuration(absPath);

    const sourceRef: SourceRefFile = {
      kind: "file",
      path: absPath,
    };

    return {
      type: node.type,
      props: {
        ...node.props,
        sourceRef,
        durationSamples: probed.durationSamples,
      },
      children: node.children,
    };
  }

  // MusicBed node: probe src duration, then recurse into children
  if (typeName === COMPONENT_NAMES.MusicBed) {
    const src = node.props["src"] as string;
    const absPath = resolve(options.baseDir, src);
    const probed = await probeFileDuration(absPath);

    const sourceRef: SourceRefFile = {
      kind: "file",
      path: absPath,
    };

    // Recurse into children sequentially
    const resolvedChildren = await resolveChildren(node.children, episodeSampleRate, options, voiceCounter, effectiveProvider);

    return {
      type: node.type,
      props: {
        ...node.props,
        sourceRef,
        durationSamples: probed.durationSamples,
      },
      children: resolvedChildren,
    };
  }

  // Episode: extract sampleRate once, recurse
  if (typeName === COMPONENT_NAMES.Episode) {
    const sampleRate = (node.props["sampleRate"] as number | undefined) ?? 48000;
    const episodeProvider = node.props["provider"] as string | undefined;
    const resolvedChildren = await resolveChildren(node.children, sampleRate, options, voiceCounter, episodeProvider);
    return { type: node.type, props: node.props, children: resolvedChildren };
  }

  // All other nodes (Segment, Silence, Crossfade): recurse into children
  const resolvedChildren = await resolveChildren(node.children, episodeSampleRate, options, voiceCounter, effectiveProvider);
  return { type: node.type, props: node.props, children: resolvedChildren };
}

/** Resolve children sequentially (no Promise.all). */
async function resolveChildren(
  children: SoundstageElement["children"],
  episodeSampleRate: number,
  options: PhaseAOptions,
  voiceCounter: { value: number },
  effectiveProvider?: string,
): Promise<SoundstageElement["children"]> {
  const result: SoundstageElement["children"] = [];
  for (const child of children) {
    if (child !== null && child !== undefined && typeof child === "object" && "type" in child) {
      result.push(await resolveNode(child as SoundstageElement, episodeSampleRate, options, voiceCounter, effectiveProvider));
    } else {
      result.push(child);
    }
  }
  return result;
}

/**
 * Phase A: validate + resolve inheritance, then synthesize all Voice nodes and
 * probe all Clip/MusicBed src files. Returns a resolved tree where every leaf
 * has sourceRef and durationSamples.
 *
 * validateTree() is the sole entry point — do NOT call resolveInheritance separately.
 * Throws SoundstageError on validation errors (before any synthesis).
 * Synthesis is sequential (no Promise.all) per §5.7.
 */
export async function phaseA(
  rawTree: SoundstageElement,
  options: PhaseAOptions,
): Promise<SoundstageElement> {
  // validateTree: resolves inheritance AND validates. Throws on error.
  const resolvedTree = validateTree(rawTree, options.baseDir);

  // Extract sampleRate from Episode root — computed once
  const episodeSampleRate = (resolvedTree.props["sampleRate"] as number | undefined) ?? 48000;

  const voiceCounter = { value: 0 };
  return resolveNode(resolvedTree, episodeSampleRate, options, voiceCounter);
}
