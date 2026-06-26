// §4.5 — canonicalJSON: deterministic JSON serialization for cache keys and IR comparison.
// Rules (each is a footgun → each is unit-tested):
//   - Keys sorted lexicographically, no insignificant whitespace, UTF-8.
//   - Floats: round to 6 decimal places, strip trailing zeros, -0 → 0, NaN/Inf → throw.
//   - String values: Unicode NFC, CRLF→LF, collapse runs of horizontal whitespace, trim.

/**
 * Serialize a number with the fixed float format:
 * round to 6 decimal places, strip trailing zeros, -0 → 0, throw on NaN/Inf.
 */
function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`canonicalJSON: non-finite number not allowed: ${n}`);
  }
  // Numbers ≥ 1e21 serialize as exponential notation (e.g. "1e+21") in both
  // JSON.stringify and Number#toString, breaking the canonical contract.
  if (Math.abs(n) >= 1e21) {
    throw new TypeError(`canonicalJSON: number too large (would use exponential notation): ${n}`);
  }
  // Treat -0 as 0
  if (Object.is(n, -0)) return "0";

  // Round to 6 decimal places, then strip trailing zeros.
  // toFixed(6) gives exactly 6 decimal places; we then trim trailing zeros
  // and a trailing decimal point.
  const fixed = n.toFixed(6);
  // Strip trailing zeros after the decimal point
  const stripped = fixed.replace(/\.?0+$/, "");
  return stripped;
}

/**
 * Normalize a string value for cache-key inclusion:
 * Unicode NFC, CRLF→LF, collapse horizontal whitespace runs to a single space, trim.
 */
function normalizeString(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ") // collapse horizontal whitespace (not newlines) to single space
    .trim();
}

/**
 * Recursively serialize a value into canonical JSON.
 * - Object keys are sorted lexicographically.
 * - Numbers use serializeNumber (float-stable).
 * - Strings are normalized (NFC, CRLF→LF, whitespace collapse, trim).
 * - Arrays preserve insertion order.
 * - null, boolean are passed through.
 */
function serializeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value === "string") return JSON.stringify(normalizeString(value));
  if (Array.isArray(value)) {
    const items = value.map((v) => serializeValue(v as unknown));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${serializeValue(obj[k])}`);
    return `{${pairs.join(",")}}`;
  }
  throw new TypeError(`canonicalJSON: unsupported value type: ${typeof value}`);
}

/**
 * Produce a canonical (deterministic, key-sorted, float-stable) JSON string.
 * Safe to use as a cache key input and for IR comparison.
 */
export function canonicalJSON(obj: unknown): string {
  return serializeValue(obj);
}

/**
 * Normalize text for cache key derivation and for passing to the adapter.
 * The adapter receives the SAME normalized text so audio matches the key.
 */
export function normalizeText(text: string): string {
  return normalizeString(text);
}
