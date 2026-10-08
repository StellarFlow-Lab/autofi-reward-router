import type { AnchorConfig, RewardEvent, RewardRecord } from '../types';
import type { PreferencesProvider } from '../services/sorobanClient';
import type { Wallet } from '../services/stellarWallet';
import type { AnchorClient } from '../services/anchorClient';
import type { StateStore } from '../services/stateStore';
import type { RateLimiter } from '../services/rateLimiter';
import type { MetricsCollector } from '../utils/metrics';
import { percentOf, toStroops } from '../utils/amount';
import { logger as rootLogger, errorMessage, type Logger } from '../utils/logger';

export interface ProcessorDeps {
  preferences: PreferencesProvider;
  wallet: Wallet;
  anchors: Record<string, AnchorConfig>;
  anchorClient: AnchorClient | null; // null = SEP-24 disabled
  store: StateStore;
  metrics: MetricsCollector;
  rateLimiter?: RateLimiter;
  dryRun: boolean;
  logger?: Logger;
}

/**
 * The off-ramp pipeline for a single reward:
 *   1. idempotency check        4. swap via the Stellar DEX (path payment)
 *   2. read the split rule      5. open a SEP-24 withdrawal with the anchor
 *   3. compute off-ramp share
 * Never throws — every outcome is recorded in the state store.
 */
export function createRewardProcessor(deps: ProcessorDeps) {
  const log = deps.logger ?? rootLogger.child('processor');
  const { store, metrics } = deps;

  return async function processReward(event: RewardEvent): Promise<RewardRecord> {
    const existing = store.get(event.id);
    if (existing) {
      if (existing.status === 'processing') {
        // We crashed mid-swap last time. Retrying could swap twice, so stop and flag it.
        log.error(`Reward ${event.id} was interrupted while processing — check swap manually, not retrying`);
        return store.upsert({ ...existing, status: 'failed', reason: 'interrupted during processing; verify on-chain before retrying' });
      }
      log.debug(`Reward ${event.id} already handled (${existing.status})`);
      return existing;
    }

    const started = Date.now();
    metrics.recordReceived();
    await deps.rateLimiter?.waitIfNeeded('rewards');

    const base = {
      eventId: event.id,
      rewardTxHash: event.txHash,
      developerPublicKey: event.developerPublicKey,
      source: event.source,
      receivedAmount: event.amount,
      receivedAsset: event.asset.code,
      dryRun: deps.dryRun,
    };
    const skip = (reason: string) => {
      log.info(`Skipping reward ${event.id}: ${reason}`);
      metrics.recordSkipped();
      return store.upsert({ ...base, status: 'skipped', reason });
    };

    let record: RewardRecord | undefined;
    try {
      const prefs = await deps.preferences.getPreferences(event.developerPublicKey);
      if (!prefs) return skip('no routing preferences configured');
      if (prefs.offRampPct === 0) return skip('preferences keep 100% in crypto');

      const anchor = deps.anchors[prefs.anchorAssetCode];
      if (!anchor) throw new Error(`Anchor ${prefs.anchorAssetCode} is not enabled in this deployment`);
      if (anchor.issuer !== prefs.anchorIssuer) {
        throw new Error(`On-chain issuer for ${anchor.code} (${prefs.anchorIssuer}) doesn't match configured issuer (${anchor.issuer})`);
      }

      const offRampAmount = percentOf(event.amount, prefs.offRampPct);
      if (toStroops(offRampAmount) === 0n) return skip('off-ramp share rounds to zero');

      log.info(`Routing ${prefs.offRampPct}% of ${event.amount} ${event.asset.code} = ${offRampAmount} → ${anchor.code} (${anchor.currency}); keeping ${prefs.keepCryptoPct}%`);

      record = store.upsert({ ...base, status: 'processing', offRampAmount, destAsset: anchor.code });

      const swap = await deps.wallet.swap(event.asset, offRampAmount, { code: anchor.code, issuer: anchor.issuer });
      record = store.upsert({ ...record, status: 'swapped', swapTxHash: swap.txHash, destAmount: swap.received });
      metrics.recordSuccess(event.asset.code, offRampAmount, Date.now() - started);

      if (!deps.anchorClient) return record;
      if (deps.dryRun) {
        log.info(`[dry-run] would open a SEP-24 withdrawal of ${swap.received} ${anchor.code} at ${anchor.homeDomain}`);
        return record;
      }

      return openWithdrawal(record, anchor, deps, log);
    } catch (err) {
      const message = errorMessage(err);
      log.error(`Reward ${event.id} failed`, message);
      metrics.recordFailure(message);
      return store.upsert({ ...base, ...record, status: 'failed', reason: message });
    }
  };
}

export type RewardProcessor = ReturnType<typeof createRewardProcessor>;

/**
 * Open a SEP-24 interactive withdrawal for a swapped reward. Never throws: if
 * the anchor is unreachable the record stays `swapped` (funds are safe in the
 * anchor asset) and can be retried via POST /rewards/:id/withdraw.
 */
export async function openWithdrawal(
  record: RewardRecord,
  anchor: AnchorConfig,
  deps: Pick<ProcessorDeps, 'anchorClient' | 'store' | 'metrics'>,
  log: Logger = rootLogger.child('processor'),
): Promise<RewardRecord> {
  if (!deps.anchorClient) throw new Error('SEP-24 is disabled');
  try {
    const w = await deps.anchorClient.startWithdrawal(anchor, record.destAmount!);
    deps.metrics.recordWithdrawalStarted();
    log.info(`➡  Finish your ${anchor.currency} bank/mobile-money payout here (one-time KYC may be required): ${w.url}`);
    return deps.store.upsert({
      ...record,
      status: 'withdrawal_pending',
      reason: undefined,
      withdrawal: {
        anchorTxId: w.id,
        homeDomain: anchor.homeDomain,
        interactiveUrl: w.url,
        status: 'incomplete',
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    log.warn('Swap done but SEP-24 withdrawal could not be started', errorMessage(err));
    return deps.store.upsert({ ...record, reason: `withdrawal not started: ${errorMessage(err)}` });
  }
}
