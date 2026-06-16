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
        // Placeholder — raise as coverage grows across tasks
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
});
