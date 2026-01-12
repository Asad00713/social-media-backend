import { Logger } from '@nestjs/common';

const logger = new Logger('DatabaseRetry');

interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: string[];
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  retryableErrors: [
    'ETIMEDOUT',
    'ENETUNREACH',
    'ECONNRESET',
    'ECONNREFUSED',
    'fetch failed',
    'network',
    'timeout',
  ],
};

function isRetryableError(error: unknown, retryableErrors: string[]): boolean {
  if (error instanceof Error) {
    const errorString = `${error.message} ${error.name} ${(error as any).code || ''}`.toLowerCase();
    return retryableErrors.some((re) => errorString.includes(re.toLowerCase()));
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a database operation with automatic retry on transient failures.
 * Uses exponential backoff with jitter.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error, opts.retryableErrors)) {
        throw error;
      }

      if (attempt === opts.maxAttempts) {
        logger.error(
          `Database operation failed after ${opts.maxAttempts} attempts`,
          error instanceof Error ? error.stack : String(error),
        );
        throw error;
      }

      // Exponential backoff with jitter
      const baseDelay = opts.initialDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 0.3 * baseDelay;
      const delay = Math.min(baseDelay + jitter, opts.maxDelayMs);

      logger.warn(
        `Database operation failed (attempt ${attempt}/${opts.maxAttempts}), ` +
          `retrying in ${Math.round(delay)}ms: ${error instanceof Error ? error.message : String(error)}`,
      );

      await sleep(delay);
    }
  }

  throw lastError;
}
