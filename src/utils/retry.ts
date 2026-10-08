import { logger as defaultLogger, errorMessage, type Logger } from './logger';

export interface RetryOptions {
  retries?: number;           // total attempts = retries + 1
  initialDelayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  /** Return false to stop retrying (e.g. for a 4xx or a failed transaction). */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  label?: string;
  logger?: Logger;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function retryAsync<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    retries = 3,
    initialDelayMs = 1000,
    backoffMultiplier = 2,
    maxDelayMs = 30_000,
    shouldRetry = () => true,
    label = 'operation',
    logger = defaultLogger,
  } = opts;

  let delay = initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt > retries || !shouldRetry(err, attempt)) throw err;
      logger.warn(`${label} failed (attempt ${attempt}/${retries + 1}), retrying in ${delay}ms`, errorMessage(err));
      await sleep(delay);
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }
}

/** Sleep up to `ms`, waking early once `keepWaiting()` turns false (for fast shutdown). */
export async function sleepWhile(ms: number, keepWaiting: () => boolean, stepMs = 250): Promise<void> {
  const end = Date.now() + ms;
  while (keepWaiting() && Date.now() < end) {
    await sleep(Math.min(stepMs, end - Date.now()));
  }
}
