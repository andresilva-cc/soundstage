// §4.6 — Structured error codes and format

export type ErrorCode =
  | "E_MISSING_PROP"
  | "E_CROSSFADE_BOUNDARY"
  | "E_SRC_NOT_FOUND"
  | "E_CROSSFADE_DURATION" // thrown in Task 7 (Phase B, where sample durations are known) — not dead code
  | "E_INVALID_PROP"
  | "E_MAX_DEPTH"
  | "E_MULTI_BED_UNSUPPORTED";

export class SoundstageError extends Error {
  readonly code: ErrorCode;
  readonly path: string;

  constructor(code: ErrorCode, message: string, path: string) {
    super(`soundstage: error[${code}]: ${message}\n  at ${path}`);
    this.name = "SoundstageError";
    this.code = code;
    this.path = path;
  }
}

export function formatPath(parts: string[]): string {
  return parts.join(" → ");
}
