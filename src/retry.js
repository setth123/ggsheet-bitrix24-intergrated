export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` and retries it with exponential backoff + jitter while the error is retryable.
 * Delay for attempt n (0-based) = baseDelayMs * 2^n + random(0..baseDelayMs).
 */
export async function withRetry(fn, {
  retries = 3,
  baseDelayMs = 1000,
  isRetryable = (err) => err.retryable === true,
  logger,
  label = 'request',
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
      logger?.warn(`${label} thất bại (lần ${attempt + 1}/${retries + 1}): ${err.message}. Thử lại sau ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
}
