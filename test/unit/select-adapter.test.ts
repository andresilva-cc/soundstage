// Unit tests for selectAdapter() in src/cli/index.ts.
// Tests adapter selection based on mode + provider, and the warning for --draft + --provider.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { selectAdapter } from "../../src/cli/select-adapter.js";
import { SyntheticAdapter } from "../../src/adapters/synthetic/index.js";
import { OpenAiAdapter } from "../../src/adapters/openai/index.js";

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Draft mode — always returns SyntheticAdapter
// ---------------------------------------------------------------------------

describe("selectAdapter — draft mode", () => {
  it("returns SyntheticAdapter when mode is 'draft' with no provider", async () => {
    const adapter = await selectAdapter("draft", null);
    expect(adapter).toBeInstanceOf(SyntheticAdapter);
  });

  it("returns SyntheticAdapter when mode is 'draft' with provider 'openai' (provider ignored)", async () => {
    const adapter = await selectAdapter("draft", "openai");
    expect(adapter).toBeInstanceOf(SyntheticAdapter);
  });

  it("emits a warning to stderr when draft + provider is set", async () => {
    const writeSpy = vi.mocked(process.stderr.write);
    await selectAdapter("draft", "openai");
    const warnings = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes("--provider") && w.includes("ignored"))).toBe(true);
  });

  it("does NOT emit a warning when draft + provider is null", async () => {
    const writeSpy = vi.mocked(process.stderr.write);
    await selectAdapter("draft", null);
    const warnings = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes("warning"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Final mode — provider selection
// ---------------------------------------------------------------------------

describe("selectAdapter — final mode, no provider (kokoro default)", () => {
  it("returns a KokoroAdapter when provider is null (backward-compat)", async () => {
    const adapter = await selectAdapter("final", null);
    // KokoroAdapter is lazy-loaded; just check the id.
    expect(adapter.id).toBe("kokoro");
  });

  it("returns a KokoroAdapter when provider is 'kokoro'", async () => {
    const adapter = await selectAdapter("final", "kokoro");
    expect(adapter.id).toBe("kokoro");
  });
});

describe("selectAdapter — final mode, provider 'openai'", () => {
  it("returns OpenAiAdapter", async () => {
    const adapter = await selectAdapter("final", "openai");
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
  });

  it("returned adapter has id 'openai'", async () => {
    const adapter = await selectAdapter("final", "openai");
    expect(adapter.id).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// Unknown provider — throws
// ---------------------------------------------------------------------------

describe("selectAdapter — unknown provider", () => {
  it("throws an Error for an unrecognised provider string", async () => {
    await expect(selectAdapter("final", "unknown-provider")).rejects.toThrow(Error);
  });

  it("error message mentions the bad provider value", async () => {
    await expect(selectAdapter("final", "magic-tts")).rejects.toThrow(/magic-tts/);
  });

  it("error message lists valid providers", async () => {
    await expect(selectAdapter("final", "bad")).rejects.toThrow(/kokoro|openai|elevenlabs/);
  });
});
