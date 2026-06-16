import { writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import type { SoundstageElement } from "../jsx-runtime/index.js";
import { SoundstageError } from "../ir/errors.js";

/**
 * Bundles and dynamically imports a .tsx/.jsx file, returning its default export.
 * The file must `export default` a SoundstageElement tree.
 *
 * Uses esbuild.build with bundle:true and an alias that maps `soundstage` /
 * `soundstage/jsx-runtime` to this package's own dist files (resolved relative
 * to import.meta.url so the alias is correct whether the loader runs from
 * src/ in dev or from dist/ as the installed CLI binary).
 *
 * Bundling inlines the jsx-runtime so the temp .mjs has no external `soundstage`
 * import to resolve at Node runtime — fixing the "Cannot find package 'soundstage'"
 * error that occurred when the temp file was written to /tmp.
 */
export async function loadTsx(filePath: string): Promise<SoundstageElement> {
  // Resolve this package's dist root relative to loader's own location.
  // From src/cli/loader.ts  → ../../dist/ = <root>/dist/
  // From dist/cli/loader.js → ../../dist/ = <root>/dist/
  const distRoot = fileURLToPath(new URL("../../dist", import.meta.url));
  const jsxRuntimePath = join(distRoot, "jsx-runtime", "index.js");
  const pkgMainPath = join(distRoot, "index.js");

  // Guard: ensure dist files exist before attempting to bundle.
  if (!existsSync(jsxRuntimePath) || !existsSync(pkgMainPath)) {
    throw new Error(
      "soundstage: build the package first (npm run build) — dist/ alias targets not found",
    );
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "soundstage-"));
  const tmpPath = join(tmpDir, "composition.mjs");

  let result: esbuild.BuildResult;
  try {
    result = await esbuild.build({
      entryPoints: [filePath],
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      jsxImportSource: "soundstage",
      alias: {
        "soundstage/jsx-runtime": jsxRuntimePath,
        soundstage: pkgMainPath,
      },
      outfile: tmpPath,
    });
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`soundstage: failed to bundle ${filePath}: ${msg}`);
  }

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      process.stderr.write(`soundstage: notice: ${w.text}\n`);
    }
  }

  const outputFile = result.outputFiles?.[0];
  if (outputFile === undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`soundstage: esbuild produced no output for ${filePath}`);
  }

  // Exclusive create: fail if file already exists (CWE-377 fix, consistent with run.ts).
  writeFileSync(tmpPath, outputFile.contents, { flag: "wx" });

  try {
    const mod = (await import(tmpPath)) as { default?: unknown };
    const exported = mod.default;

    // Validate that the default export is a SoundstageElement (has type + props + children).
    if (
      exported === undefined ||
      exported === null ||
      typeof exported !== "object" ||
      !("type" in exported) ||
      !("props" in exported) ||
      !("children" in exported)
    ) {
      throw new SoundstageError(
        "E_NO_DEFAULT_EXPORT",
        `${filePath} must \`export default\` a SoundstageElement (jsx call). Got: ${exported === undefined ? "undefined (missing export default)" : typeof exported}.`,
        filePath,
      );
    }

    return exported as SoundstageElement;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
