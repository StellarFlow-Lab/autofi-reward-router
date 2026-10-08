import { addAmounts } from './amount';

export interface Metrics {
  startedAt: string;
  rewardsReceived: number;
  rewardsSkipped: number;
  successfulSwaps: number;
  failedSwaps: number;
  withdrawalsStarted: number;
  withdrawalsCompleted: number;
  /** Total off-ramped amount per source asset code. */
  offRampedByAsset: Record<string, string>;
  avgProcessingTimeMs: number;
  lastError?: { at: string; message: string };
}

export class MetricsCollector {
  private metrics!: Metrics;
  private totalProcessingMs = 0;

  constructor() {
    this.reset();
  }

  recordReceived() {
    this.metrics.rewardsReceived++;
  }

  recordSkipped() {
    this.metrics.rewardsSkipped++;
  }

  recordSuccess(assetCode: string, amount: string, processingTimeMs: number) {
    this.metrics.successfulSwaps++;
    const prev = this.metrics.offRampedByAsset[assetCode] ?? '0';
    this.metrics.offRampedByAsset[assetCode] = addAmounts(prev, amount);
    this.totalProcessingMs += processingTimeMs;
    this.metrics.avgProcessingTimeMs = Math.round(this.totalProcessingMs / this.metrics.successfulSwaps);
  }

  recordFailure(message: string) {
    this.metrics.failedSwaps++;
    this.metrics.lastError = { at: new Date().toISOString(), message };
  }

  recordWithdrawalStarted() {
    this.metrics.withdrawalsStarted++;
  }

  recordWithdrawalCompleted() {
    this.metrics.withdrawalsCompleted++;
  }

  getMetrics(): Metrics {
    return structuredClone(this.metrics);
  }

  reset() {
    this.totalProcessingMs = 0;
    this.metrics = {
      startedAt: new Date().toISOString(),
      rewardsReceived: 0,
      rewardsSkipped: 0,
      successfulSwaps: 0,
      failedSwaps: 0,
      withdrawalsStarted: 0,
      withdrawalsCompleted: 0,
      offRampedByAsset: {},
      avgProcessingTimeMs: 0,
    };
  }
}

export const metricsCollector = new MetricsCollector();
