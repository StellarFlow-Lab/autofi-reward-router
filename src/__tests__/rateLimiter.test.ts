import { RateLimiter } from '../services/rateLimiter';

describe('RateLimiter', () => {
  test('allows bursts up to capacity without waiting', async () => {
    const limiter = new RateLimiter(3, 1);
    const start = Date.now();
    await Promise.all([limiter.waitIfNeeded('k'), limiter.waitIfNeeded('k'), limiter.waitIfNeeded('k')]);
    expect(Date.now() - start).toBeLessThan(100);
  });

  test('throttles beyond capacity, even for concurrent callers', async () => {
    const limiter = new RateLimiter(1, 10); // 1 token per 100ms
    const start = Date.now();
    await Promise.all([limiter.waitIfNeeded('k'), limiter.waitIfNeeded('k'), limiter.waitIfNeeded('k')]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(180);
  });

  test('keys are independent and reset refills', async () => {
    const limiter = new RateLimiter(1, 0.001);
    await limiter.waitIfNeeded('a');
    expect(limiter.available('a')).toBeLessThan(1);
    expect(limiter.available('b')).toBe(1);
    limiter.reset('a');
    expect(limiter.available('a')).toBe(1);
  });

  test('validates arguments', () => {
    expect(() => new RateLimiter(0, 1)).toThrow();
    expect(() => new RateLimiter(1, 0)).toThrow();
  });
});
