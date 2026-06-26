// Adapter selection logic — extracted for testability without importing the full CLI module.
// Imported by src/cli/index.ts and by tests.

import { SyntheticAdapter } from "../adapters/synthetic/index.js";
import { OpenAiAdapter } from "../adapters/openai/index.js";
import type { TtsAdapter } from "../adapters/types.js";

/** Adapter mode: synthetic (--draft) or real TTS (--final / default). */
export type AdapterMode = "draft" | "final";

/**
 * Select and return the appropriate TTS adapter.
 * - draft mode: always SyntheticAdapter; provider is ignored (warning emitted to stderr if set).
 * - final mode: provider determines the adapter (default "kokoro" when null).
 * Throws a plain Error for unrecognised provider strings; caller's handleError maps to exit 1.
 */
export async function selectAdapter(
  mode: AdapterMode,
  provider: string | null,
): Promise<TtsAdapter> {
  if (mode === "draft") {
    if (provider !== null) {
      process.stderr.write(
        `soundstage: warning: --provider is ignored with --draft (using synthetic adapter)\n`,
      );
    }
    return new SyntheticAdapter();
  }

  // mode === "final": resolve provider (null → "kokoro" default for backward compat).
  const resolvedProvider = provider ?? "kokoro";

  switch (resolvedProvider) {
    case "kokoro":
      // Lazy-load KokoroAdapter so --draft/synthetic paths never pull in the module.
      return import("../adapters/kokoro/index.js").then(
        ({ KokoroAdapter }) => new KokoroAdapter(),
      );
    case "openai":
      return new OpenAiAdapter();
    case "elevenlabs":
      // T2 will implement this adapter; handleError already adds "soundstage: error: " prefix.
      throw new Error(
        `--provider elevenlabs is not yet available (coming soon)`,
      );
    default:
      // handleError prepends "soundstage: error: " — do NOT duplicate it here.
      throw new Error(
        `unknown --provider '${resolvedProvider}' (valid: kokoro, openai, elevenlabs)`,
      );
  }
}
