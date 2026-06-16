import { describe, it, expect } from "vitest";
import * as jsxRuntime from "soundstage/jsx-runtime";

describe("jsx-runtime", () => {
  it("resolves soundstage/jsx-runtime in test env", () => {
    // Guards that vitest esbuild config routes jsxImportSource correctly.
    // The runtime is a stub until Task 2; importing without error is sufficient.
    expect(jsxRuntime).toBeDefined();
  });
});
