import { defineConfig } from "vitest/config";

export default defineConfig({
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
