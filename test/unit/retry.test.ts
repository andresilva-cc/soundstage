// Unit tests for the withRetry cloud utility (src/adapters/cloud/retry.ts).
// Uses vi.useFakeTimers() to avoid real delays and capture setTimeout calls.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, HttpResponseError } from "../../src/adapters/cloud/retry.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withRetry — exports", () => {
  it("withRetry is a function", () => {
    expect(typeof withRetry).toBe("function");
  });

  it("HttpResponseError is a constructor", () => {
    expect(typeof HttpResponseError).toBe("function");
    const err = new HttpResponseError(429, "Rate limited");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(429);
    expect(err.message).toBe("Rate limited");
  });
});

describe("withRetry — success on first attempt", () => {
  it("calls fn once and returns result", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const promise = withRetry(fn);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("withRetry — retries on 429", () => {
  it("retries twice on 429 then succeeds (3 total calls)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpResponseError(429, "Rate limited"))
      .mockRejectedValueOnce(new HttpResponseError(429, "Rate limited"))
      .mockResolvedValue("success");

    const promise = withRetry(fn, { initialDelayMs: 100 });
    // Advance through all timers (backoff delays).
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(3);
    expect(result).toBe("success");
  });

  it("passes increasing delay values to setTimeout (exponential backoff)", async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (callback: (...args: any[]) => void, delay?: number, ...args: unknown[]) => {
        delays.push(delay ?? 0);
        return realSetTimeout(callback, 0, ...args);
      },
    );

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpResponseError(429, "Rate limited"))
      .mockRejectedValueOnce(new HttpResponseError(429, "Rate limited"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { initialDelayMs: 1000 });
    await vi.runAllTimersAsync();
    await promise;

    // Two retries → two setTimeout calls.
    expect(delays.length).toBeGreaterThanOrEqual(2);
    // Second delay must be strictly larger than the first (exponential backoff ordering).
    // With base×2 factor and ±20% jitter: attempt-2 base = 2000, attempt-1 base = 1000.
    // Worst case: delay[1] ≥ 2000 × 0.8 = 1600, delay[0] ≤ 1000 × 1.2 = 1200 → always holds.
    expect(delays[1]).toBeGreaterThan(delays[0]!);
    vi.restoreAllMocks();
  });
});

describe("withRetry — retries on 5xx", () => {
  it("retries on 500 and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpResponseError(500, "Server error"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { initialDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toBe("ok");
  });

  it("retries on 503", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpResponseError(503, "Service unavailable"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { initialDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toBe("ok");
  });
});

describe("withRetry — does NOT retry on 4xx (except 429)", () => {
  it("does not retry on 400 (fail once, re-throw)", async () => {
    const err = new HttpResponseError(400, "Bad request");
    const fn = vi.fn().mockRejectedValue(err);
    // No vi.runAllTimersAsync(): non-retriable errors throw immediately, no delays.
    await expect(withRetry(fn, { initialDelayMs: 10 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 401", async () => {
    const err = new HttpResponseError(401, "Unauthorized");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { initialDelayMs: 10 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 403", async () => {
    const err = new HttpResponseError(403, "Forbidden");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { initialDelayMs: 10 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("withRetry — exhaustion", () => {
  it("re-throws after exhausting all 3 attempts on persistent 429", async () => {
    const err = new HttpResponseError(429, "Rate limited");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, { initialDelayMs: 10 });
    // Suppress the unhandled-rejection warning while timers run; the original
    // promise reference is unaffected and can still be asserted against below.
    const suppressed = promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await suppressed;

    await expect(promise).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // 3 attempts = default maxAttempts
  });

  it("respects custom maxAttempts", async () => {
    const err = new HttpResponseError(429, "Rate limited");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, { maxAttempts: 5, initialDelayMs: 10 });
    const suppressed = promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await suppressed;

    await expect(promise).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(5);
  });
});

describe("withRetry — non-HttpResponseError errors", () => {
  it("does not retry on plain Error", async () => {
    const err = new Error("Something went wrong");
    const fn = vi.fn().mockRejectedValue(err);
    // Plain Error is not retriable — throws immediately, no delays.
    await expect(withRetry(fn, { initialDelayMs: 10 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("withRetry — retries on TypeError (fetch network error)", () => {
  it("retries on TypeError and succeeds on second attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { initialDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toBe("ok");
  });

  it("re-throws TypeError after exhausting all attempts", async () => {
    const err = new TypeError("fetch failed");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, { initialDelayMs: 10 });
    const suppressed = promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    await suppressed;

    await expect(promise).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
