import { MetricsCollector } from '../utils/metrics';

describe('MetricsCollector', () => {
  test('tracks swaps, amounts per asset and timing', () => {
    const m = new MetricsCollector();
    m.recordReceived(); m.recordReceived(); m.recordReceived();
    m.recordSuccess('USDC', '0.1', 1000);
    m.recordSuccess('USDC', '0.2', 3000);
    m.recordFailure('boom');
    const s = m.getMetrics();
    expect(s).toMatchObject({ rewardsReceived: 3, successfulSwaps: 2, failedSwaps: 1, avgProcessingTimeMs: 2000 });
    expect(s.offRampedByAsset.USDC).toBe('0.3000000');
    expect(s.lastError?.message).toBe('boom');
    m.reset();
    expect(m.getMetrics().successfulSwaps).toBe(0);
  });
});
