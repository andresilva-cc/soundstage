// Unit tests for canonicalJSON — adversarial inputs targeting each canonicalization rule.
// Every test here catches a distinct class of silent cache bug (§4.5, §9).

import { describe, it, expect } from "vitest";
import { canonicalJSON } from "../../src/adapters/cache/canonical.js";

describe("canonicalJSON — key sorting", () => {
  it("sorts keys lexicographically", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("produces same output regardless of insertion order", () => {
    const a = canonicalJSON({ b: 1, a: 2 });
    const b = canonicalJSON({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("sorts nested object keys too", () => {
    const a = canonicalJSON({ z: { b: 1, a: 2 } });
    expect(a).toBe('{"z":{"a":2,"b":1}}');
  });

  it("nested key order independence at depth ≥ 2 — both insertion orders produce same output", () => {
    const orderA = canonicalJSON({ outer: { z: { b: 1, a: 2 }, y: 3 }, x: 4 });
    const orderB = canonicalJSON({ x: 4, outer: { y: 3, z: { a: 2, b: 1 } } });
    expect(orderA).toBe(orderB);
  });

  it("no insignificant whitespace", () => {
    const result = canonicalJSON({ a: 1, b: 2 });
    expect(result).not.toMatch(/\s/);
  });
});

describe("canonicalJSON — float serialization", () => {
  it("1.1 and 1.100000 produce identical output", () => {
    expect(canonicalJSON({ x: 1.1 })).toBe(canonicalJSON({ x: 1.100000 }));
  });

  it("1.1 and 1.1000001 ARE equal (both round to 6dp → same key)", () => {
    expect(canonicalJSON({ x: 1.1 })).toBe(canonicalJSON({ x: 1.1000001 }));
  });

  it("1.1 and 1.1001 produce DIFFERENT output (differ at 4th decimal place)", () => {
    expect(canonicalJSON({ x: 1.1 })).not.toBe(canonicalJSON({ x: 1.1001 }));
  });

  it("strips trailing zeros from floats", () => {
    expect(canonicalJSON({ x: 1.0 })).toBe('{"x":1}');
    expect(canonicalJSON({ x: 2.50 })).toBe('{"x":2.5}');
  });

  it("integer 1 serializes as 1 not 1.000000", () => {
    expect(canonicalJSON({ x: 1 })).toBe('{"x":1}');
  });

  it("-0 serializes as 0", () => {
    expect(canonicalJSON({ x: -0 })).toBe('{"x":0}');
  });

  it("1.1 vs 1.2 produce different output", () => {
    expect(canonicalJSON({ x: 1.1 })).not.toBe(canonicalJSON({ x: 1.2 }));
  });

  it("throws TypeError on NaN", () => {
    expect(() => canonicalJSON({ x: NaN })).toThrow(TypeError);
  });

  it("throws TypeError on Infinity", () => {
    expect(() => canonicalJSON({ x: Infinity })).toThrow(TypeError);
  });

  it("throws TypeError on negative Infinity", () => {
    expect(() => canonicalJSON({ x: -Infinity })).toThrow(TypeError);
  });

  it("speed: 1.1 vs 1.10 vs 1.100000 all produce the same output", () => {
    const a = canonicalJSON({ speed: 1.1 });
    const b = canonicalJSON({ speed: 1.10 });
    const c = canonicalJSON({ speed: 1.100000 });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("speed: 1.1 vs 1.2 produce different output", () => {
    expect(canonicalJSON({ speed: 1.1 })).not.toBe(canonicalJSON({ speed: 1.2 }));
  });

  it("rounds to 6 decimal places", () => {
    // 1/3 ≈ 0.333333333... rounds to 0.333333
    expect(canonicalJSON({ x: 1 / 3 })).toBe('{"x":0.333333}');
  });
});

describe("canonicalJSON — text normalization (for string values)", () => {
  it("CRLF in string value normalizes to LF", () => {
    expect(canonicalJSON({ t: "hello\r\nworld" })).toBe(
      canonicalJSON({ t: "hello\nworld" })
    );
  });

  it("runs of horizontal whitespace collapse to single space", () => {
    expect(canonicalJSON({ t: "hello   world" })).toBe(
      canonicalJSON({ t: "hello world" })
    );
  });

  it("tabs collapse with spaces into single space", () => {
    expect(canonicalJSON({ t: "hello\t\tworld" })).toBe(
      canonicalJSON({ t: "hello world" })
    );
  });

  it("leading and trailing whitespace are trimmed", () => {
    expect(canonicalJSON({ t: "  hello  " })).toBe(canonicalJSON({ t: "hello" }));
  });

  it("NFD é normalizes to NFC é (same key)", () => {
    const nfd = "é"; // e + combining accent = NFD form of é
    const nfc = "é";  // precomposed é
    expect(canonicalJSON({ t: nfd })).toBe(canonicalJSON({ t: nfc }));
  });

  it("genuinely different text produces different output", () => {
    expect(canonicalJSON({ t: "hello" })).not.toBe(canonicalJSON({ t: "world" }));
  });
});

describe("canonicalJSON — large number guard (1e21 exponential-notation boundary)", () => {
  it("throws TypeError on 1e21 (would serialize as '1e+21' in JSON.stringify)", () => {
    expect(() => canonicalJSON({ x: 1e21 })).toThrow(TypeError);
  });

  it("throws TypeError on -1e21", () => {
    expect(() => canonicalJSON({ x: -1e21 })).toThrow(TypeError);
  });

  it("does not throw for 9.99e20 (just below the boundary)", () => {
    expect(() => canonicalJSON({ x: 9.99e20 })).not.toThrow();
  });
});

describe("canonicalJSON — types", () => {
  it("string values are quoted", () => {
    expect(canonicalJSON({ a: "hello" })).toBe('{"a":"hello"}');
  });

  it("null is serialized as null", () => {
    expect(canonicalJSON({ a: null })).toBe('{"a":null}');
  });

  it("boolean true", () => {
    expect(canonicalJSON({ a: true })).toBe('{"a":true}');
  });

  it("boolean false", () => {
    expect(canonicalJSON({ a: false })).toBe('{"a":false}');
  });

  it("array preserves order", () => {
    expect(canonicalJSON({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });
});
