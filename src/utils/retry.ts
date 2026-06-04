import { logger } from "../logger.js";

export interface RetryOptions {
  retries: number;
  /** Base delay in ms; grows exponentially with each attempt. */
  baseDelayMs?: number;
  /** Optional label for logging. */
  label?: string;
  /** Return false to treat an error as non-retryable. */
  shouldRetry?: (error: unknown) => boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn`, retrying on failure with exponential backoff.
 * Re-throws the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { retries, baseDelayMs = 500, label = "operation", shouldRetry } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (shouldRetry && !shouldRetry(error)) throw error;
      if (attempt === retries) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      logger.warn(
        `${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms`,
        error instanceof Error ? error.message : String(error),
      );
      await sleep(delay);
    }
  }
  throw lastError;
}
