import { sleep } from '../utils/retry';

/**
 * Token-bucket rate limiter. Calls for the same key are serialized, so
 * concurrent callers can't all observe a full bucket at once.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private queues = new Map<string, Promise<void>>();

  constructor(
    private readonly capacity = 10,
    private readonly refillRatePerSecond = 1,
    private readonly now: () => number = Date.now,
  ) {
    if (capacity < 1) throw new Error('capacity must be >= 1');
    if (refillRatePerSecond <= 0) throw new Error('refillRatePerSecond must be > 0');
  }

  waitIfNeeded(key: string): Promise<void> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.take(key));
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }

  private async take(key: string): Promise<void> {
    const bucket = this.refill(key);
    if (bucket.tokens < 1) {
      await sleep(((1 - bucket.tokens) / this.refillRatePerSecond) * 1000);
      this.refill(key);
    }
    bucket.tokens -= 1;
  }

  private refill(key: string) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillRatePerSecond);
    bucket.lastRefill = now;
    return bucket;
  }

  /** Tokens currently available for a key (for monitoring/tests). */
  available(key: string): number {
    return this.refill(key).tokens;
  }

  reset(key?: string): void {
    if (key) {
      this.buckets.delete(key);
      this.queues.delete(key);
    } else {
      this.buckets.clear();
      this.queues.clear();
    }
  }
}
