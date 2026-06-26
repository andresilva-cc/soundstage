// Phase A — Resolve & Synthesize.
// §3.1: Walk the inheritance-resolved element tree; for each Voice node, call CacheLayer.get()
// sequentially for each sentence chunk (§T7 auto segmentation), then ffprobe each Clip/MusicBed src.
// Produce a resolved tree where every Voice leaf has voiceUnitId + chunks[], and every
// Clip/MusicBed leaf has sourceRef + durationSamples.
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
import { segment } from "./segmentor.js";

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

/**
 * Per-chunk synthesis result stored in the resolved Voice node's `chunks` prop.
 * `durationSamples` is at the master sample rate (already converted from native TTS rate).
 * `sampleRate` is the native TTS sample rate the adapter returned audio at.
 */
export interface ChunkResult {
  wavPath: string;
  durationSamples: number; // at master (episode) sample rate
  sampleRate: number;      // native TTS adapter sample rate
  hash: string;
  hit: boolean;
}

export interface PhaseAOptions {
  cache: CacheLayer;
  baseDir: string;
  /**
   * Called after each chunk of each Voice node is synthesized (or served from cache).
   * Signature changed in T7: now includes chunkIndex and chunkTotal per Voice.
   */
  onVoiceSynthesized?: (voiceUnitId: number, chunkIndex: number, chunkTotal: number, hit: boolean) => void;
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

  // Voice node: segment text → synthesize each chunk sequentially via CacheLayer
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

    // Assign voiceUnitId before processing chunks
    const voiceUnitId = voiceCounter.value++;

    // Segment text into sentence-granular chunks (§T7)
    const chunks = segment(text);
    const chunkTotal = chunks.length;
    const chunkResults: ChunkResult[] = [];

    for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex++) {
      const chunkText = chunks[chunkIndex]!;

      const req: SynthRequest = {
        text: chunkText,
        voice,
        sampleRate: episodeSampleRate,
        ...(speed !== undefined ? { speed } : {}),
      };

      const result: CacheResult = await options.cache.get(req);

      // Convert native TTS sample rate → master sample rate (§3.2: all IR positions
      // are at the master rate). The cache sidecar stores samples at the adapter's
      // native rate (e.g. 24000 Hz for Kokoro/synthetic); the compiler resamples on
      // read, so the IR must express durations at episodeSampleRate.
      const durationAtMasterRate =
        result.sampleRate === episodeSampleRate
          ? result.durationSamples
          : Math.round(result.durationSamples * episodeSampleRate / result.sampleRate);

      chunkResults.push({
        wavPath: result.wavPath,
        durationSamples: durationAtMasterRate,
        sampleRate: result.sampleRate,
        hash: result.hash,
        hit: result.hit,
      });

      options.onVoiceSynthesized?.(voiceUnitId, chunkIndex, chunkTotal, result.hit);
    }

    return {
      type: node.type,
      props: {
        ...node.props,
        voiceUnitId,
        chunks: chunkResults,
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
 * Phase A: validate + resolve inheritance, then synthesize all Voice nodes (with
 * per-sentence chunk segmentation per §T7) and probe all Clip/MusicBed src files.
 * Returns a resolved tree where every Voice leaf has `voiceUnitId + chunks[]`
 * and every Clip/MusicBed leaf has `sourceRef + durationSamples`.
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
