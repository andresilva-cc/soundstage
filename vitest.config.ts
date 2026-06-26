import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "soundstage/jsx-runtime",
        replacement: fileURLToPath(
          new URL("./src/jsx-runtime/index.ts", import.meta.url),
        ),
      },
      {
        find: "soundstage",
        replacement: fileURLToPath(
          new URL("./src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "soundstage",
  },
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      thresholds: {
        // Measured with NO_KOKORO=1 (hermetic CI) 2026-06-26: lines 75.91%, branches 80.76%, functions 96.55%, statements 75.91%
        lines: 74,
        branches: 78,
        functions: 95,
        statements: 74,
      },
    },
  },
});
