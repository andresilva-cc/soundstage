import type { SoundstageElement } from "../jsx-runtime/index.js";
import { COMPONENT_NAMES } from "../components/types.js";
import { SoundstageError, formatPath } from "./errors.js";

const MAX_DEPTH = 100;

// The inheritable props per OD-1/§4.3: only Voice-affecting props cascade.
const INHERITABLE_PROPS = ["voice", "provider", "speed"] as const;

interface InheritanceContext {
  voice?: string;
  provider?: string;
  speed?: number;
}

function isInheritanceSource(typeName: string): boolean {
  return typeName === COMPONENT_NAMES.Episode || typeName === COMPONENT_NAMES.Segment;
}

function resolveNode(
  node: SoundstageElement,
  ctx: InheritanceContext,
  pathParts: string[],
  depth: number,
): SoundstageElement {
  if (depth > MAX_DEPTH) {
    throw new SoundstageError(
      "E_MAX_DEPTH",
      `Tree exceeds maximum nesting depth of ${MAX_DEPTH}`,
      formatPath(pathParts),
    );
  }

  const typeName = node.type as string;

  // Build the context to pass down to children
  let childCtx: InheritanceContext = ctx;
  if (isInheritanceSource(typeName)) {
    // Extract inheritable props from this node and merge into context (this node wins over ancestors)
    const newCtx: InheritanceContext = { ...ctx };
    for (const key of INHERITABLE_PROPS) {
      if (key in node.props && node.props[key] !== undefined) {
        (newCtx as Record<string, unknown>)[key] = node.props[key];
      }
    }
    childCtx = newCtx;
  }

  // For Voice nodes: apply inherited props (explicit props win over inherited)
  let resolvedProps = node.props;
  if (typeName === COMPONENT_NAMES.Voice) {
    const merged: Record<string, unknown> = { ...node.props };
    for (const key of INHERITABLE_PROPS) {
      // Only inherit if the Voice doesn't already have the prop set
      if (!(key in node.props) || node.props[key] === undefined) {
        if (key in childCtx && (childCtx as Record<string, unknown>)[key] !== undefined) {
          merged[key] = (childCtx as Record<string, unknown>)[key];
        }
      }
    }
    resolvedProps = merged;
  }

  const nodeLabel = `<${typeName}>`;
  const childPathParts = [...pathParts, nodeLabel];

  // Recurse into children
  const resolvedChildren = node.children.map((child) => {
    if (child !== null && child !== undefined && typeof child === "object" && "type" in child) {
      return resolveNode(child as SoundstageElement, childCtx, childPathParts, depth + 1);
    }
    return child;
  });

  return {
    type: node.type,
    props: resolvedProps,
    children: resolvedChildren,
  };
}

/**
 * Resolve inheritance — walk the element tree and propagate voice/provider/speed
 * from Episode/Segment ancestors down to descendant Voice nodes.
 * Nearest ancestor wins; explicit Voice props always override.
 * Returns a new tree (does not mutate the original).
 * Idempotent: resolving an already-resolved tree is a no-op because Voice nodes'
 * explicit effective props win over any inherited values.
 */
export function resolveInheritance(tree: SoundstageElement): SoundstageElement {
  return resolveNode(tree, {}, [], 0);
}
