// Shared retry utility for cloud TTS adapters.
// Retries on HTTP 429 (rate limit), 5xx (server error), and TypeError (network failure: DNS,
// ECONNREFUSED, connection reset) with exponential backoff + jitter.
// 4xx errors (except 429) are NOT retried — they indicate a client error (bad key, bad request).

export class HttpResponseError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpResponseError";
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
}

function isRetriable(err: unknown): boolean {
  if (err instanceof HttpResponseError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  // TypeError from fetch = transient network error (DNS failure, ECONNREFUSED, connection reset).
  if (err instanceof TypeError) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Retry `fn` up to `maxAttempts` times (default 3).
 * Waits `initialDelayMs * 2^(attempt-1)` ± 20% jitter between attempts.
 * Retries on `HttpResponseError` with status 429 or 5xx, and on `TypeError` (network errors).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const initialDelayMs = opts?.initialDelayMs ?? 1000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetriable(err)) throw err;
      if (attempt < maxAttempts) {
        const base = initialDelayMs * Math.pow(2, attempt - 1);
        // ±20% jitter: multiply by a random factor in [0.8, 1.2]
        const jitter = base * 0.2 * (Math.random() * 2 - 1);
        await sleep(base + jitter);
      }
    }
  }
  throw lastError;
}
