import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";
import type { SoundstageElement } from "../jsx-runtime/index.ts";

/**
 * Transforms and dynamically imports a .tsx/.jsx file, returning its default export.
 * The file must `export default` a SoundstageElement tree.
 *
 * OD-4: esbuild.transform with loader:'tsx', jsx:'automatic',
 *       jsxImportSource:'soundstage', format:'esm'.
 */
export async function loadTsx(filePath: string): Promise<SoundstageElement> {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`soundstage: failed to read ${filePath}: ${msg}`);
  }

  let transformed: esbuild.TransformResult;
  try {
    transformed = await esbuild.transform(source, {
      loader: "tsx",
      jsx: "automatic",
      jsxImportSource: "soundstage",
      format: "esm",
      target: "es2022",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`soundstage: failed to transform ${filePath}: ${msg}`);
  }

  if (transformed.warnings.length > 0) {
    for (const w of transformed.warnings) {
      process.stderr.write(`soundstage: notice: ${w.text}\n`);
    }
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "soundstage-"));
  const tmpPath = join(tmpDir, "composition.mjs");

  writeFileSync(tmpPath, transformed.code, "utf8");

  try {
    const mod = await import(tmpPath) as { default?: SoundstageElement };
    return mod.default as SoundstageElement;
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    if (existsSync(tmpDir)) rmdirSync(tmpDir);
  }
}
