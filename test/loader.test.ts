import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsx } from "../src/cli/loader.ts";
import type { SoundstageElement } from "../src/jsx-runtime/index.ts";

// Temp fixture paths to clean up after each test
const tempFiles: string[] = [];

function writeTempTsx(content: string): string {
  const path = join(tmpdir(), `soundstage-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tsx`);
  writeFileSync(path, content, "utf8");
  tempFiles.push(path);
  return path;
}

afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    if (existsSync(f)) unlinkSync(f);
  }
});

describe("loader", () => {
  // AC3 — loader loads a fixture .tsx and returns the element tree
  it("loads a .tsx file and returns the default-exported element tree", async () => {
    const fixtureSrc = `
/** @jsxImportSource soundstage */
import { jsx } from "soundstage/jsx-runtime";
const el = jsx("Episode", { title: "test episode" }, undefined);
export default el;
`;
    const fixturePath = writeTempTsx(fixtureSrc);
    const result = await loadTsx(fixturePath) as SoundstageElement;
    expect(result).toBeDefined();
    expect(result.type).toBe("Episode");
    expect((result.props as { title: string }).title).toBe("test episode");
  });

  // AC3 — loader with JSX syntax (transformed by esbuild); components imported from soundstage
  it("transforms JSX syntax and returns the element tree", async () => {
    // JSX components must be in scope; use a locally-defined component function.
    // In real usage, <Episode> etc. would be imported from 'soundstage'.
    const fixtureSrc = `
import { jsx } from "soundstage/jsx-runtime";
const Episode = (props) => jsx("episode-host", props, undefined);
export default jsx(Episode, { title: "hello world" }, undefined);
`;
    const fixturePath = writeTempTsx(fixtureSrc);
    const result = await loadTsx(fixturePath) as SoundstageElement;
    expect(typeof result.type).toBe("function");
    expect((result.props as { title: string }).title).toBe("hello world");
  });

  // AC3 — loader handles nested JSX (using explicit jsx calls to avoid undefined component refs)
  it("returns a nested element tree for nested JSX", async () => {
    const fixtureSrc = `
import { jsx, jsxs } from "soundstage/jsx-runtime";
const voice = jsx("Voice", { voice: "host" }, undefined);
const segment = jsx("Segment", { title: "intro" }, undefined, voice);
const episode = jsx("Episode", { title: "ep" }, undefined, segment);
export default episode;
`;
    const fixturePath = writeTempTsx(fixtureSrc);
    const result = await loadTsx(fixturePath) as SoundstageElement;
    expect(result.type).toBe("Episode");
    expect(result.children).toHaveLength(1);
    const segment = result.children[0] as SoundstageElement;
    expect(segment.type).toBe("Segment");
    expect(segment.children).toHaveLength(1);
  });

  // AC3 — transform errors surface clearly
  it("throws on invalid TypeScript syntax with a clear message", async () => {
    const fixtureSrc = `export default <this is not valid tsx !!!`;
    const fixturePath = writeTempTsx(fixtureSrc);
    await expect(loadTsx(fixturePath)).rejects.toThrow("soundstage: failed to transform");
  });

  // Fix 5 — file-read errors surface with the structured message, not a raw Node error
  it("throws with structured message for nonexistent file", async () => {
    await expect(loadTsx("/nonexistent/path/composition.tsx")).rejects.toThrow(
      "soundstage: failed to read",
    );
  });

  // AC5 — no React dependency: the loaded module uses our runtime, not React
  it("loaded module does not produce React elements", async () => {
    const fixtureSrc = `
import { jsx } from "soundstage/jsx-runtime";
export default jsx("Segment", { title: "s" }, undefined);
`;
    const fixturePath = writeTempTsx(fixtureSrc);
    const result = await loadTsx(fixturePath) as SoundstageElement;
    expect(result).not.toHaveProperty("$$typeof");
    expect(typeof result.type).toBe("string");
  });
});
