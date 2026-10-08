import type { AnchorConfig, RewardRecord } from '../types';
import type { AnchorClient, Sep24Transaction } from '../services/anchorClient';
import type { Wallet } from '../services/stellarWallet';
import type { StateStore } from '../services/stateStore';
import type { MetricsCollector } from '../utils/metrics';
import { toStroops } from '../utils/amount';
import { logger as rootLogger, errorMessage } from '../utils/logger';
import { sleepWhile } from '../utils/retry';

const log = rootLogger.child('withdrawals');

const FAILED_STATUSES = new Set(['error', 'expired', 'refunded', 'no_market', 'too_small', 'too_large']);

export interface MonitorDeps {
  anchorClient: AnchorClient;
  wallet: Wallet;
  store: StateStore;
  metrics: MetricsCollector;
  anchors: Record<string, AnchorConfig>;
  autoSend: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
}

/**
 * Drives open SEP-24 withdrawals to completion. Once the developer finishes
 * the anchor's interactive flow, the anchor reports `pending_user_transfer_start`
 * and we send it the funds (with its memo). The anchor then pays out to the
 * bank / mobile-money account and reports `completed`.
 */
export async function checkWithdrawal(record: RewardRecord, deps: Omit<MonitorDeps, 'pollIntervalMs'>): Promise<void> {
  const w = record.withdrawal!;
  const anchor = Object.values(deps.anchors).find((a) => a.code === record.destAsset && a.homeDomain === w.homeDomain);
  const update = (patch: Partial<RewardRecord>, status?: string) =>
    deps.store.upsert({
      ...record,
      ...patch,
      withdrawal: { ...w, ...patch.withdrawal, status: status ?? w.status, updatedAt: new Date().toISOString() },
    });

  if (!anchor) {
    update({ status: 'failed', reason: `anchor ${record.destAsset}@${w.homeDomain} no longer configured` });
    return;
  }
  if (Date.now() - Date.parse(record.createdAt) > deps.timeoutMs) {
    update({ status: 'failed', reason: 'withdrawal timed out waiting for the anchor' }, 'timeout');
    return;
  }

  let tx: Sep24Transaction;
  try {
    tx = await deps.anchorClient.getTransaction(anchor, w.anchorTxId);
  } catch (err) {
    log.warn(`Could not fetch status for ${w.anchorTxId}`, errorMessage(err));
    return;
  }

  if (tx.status !== w.status) log.info(`Withdrawal ${w.anchorTxId}: ${w.status} → ${tx.status}`);

  if (tx.status === 'completed') {
    deps.metrics.recordWithdrawalCompleted();
    update({ status: 'completed', reason: undefined }, tx.status);
    log.info(`✅ Payout complete for reward ${record.eventId} (${tx.amount_out ?? '?'} out)`);
    return;
  }
  if (FAILED_STATUSES.has(tx.status)) {
    update({ status: 'failed', reason: `anchor reported ${tx.status}${tx.message ? `: ${tx.message}` : ''}` }, tx.status);
    return;
  }

  if (tx.status === 'pending_user_transfer_start' && !w.paymentTxHash) {
    if (!deps.autoSend) {
      update({}, tx.status);
      log.info(`Withdrawal ${w.anchorTxId} is waiting for funds; SEP24_AUTO_SEND is off, send manually`);
      return;
    }
    if (!tx.withdraw_anchor_account) {
      log.warn(`Anchor gave no withdraw_anchor_account for ${w.anchorTxId}`);
      return;
    }
    const amount = tx.amount_in ?? record.destAmount!;
    // Never send more than this reward produced, whatever the anchor's form says.
    if (toStroops(amount) > toStroops(record.destAmount!)) {
      update({ status: 'failed', reason: `anchor requested ${amount} but only ${record.destAmount} was swapped` }, tx.status);
      return;
    }
    try {
      const hash = await deps.wallet.pay({
        to: tx.withdraw_anchor_account,
        asset: { code: anchor.code, issuer: anchor.issuer },
        amount,
        memo: tx.withdraw_memo,
        memoType: tx.withdraw_memo_type,
      });
      update({ withdrawal: { ...w, paymentTxHash: hash } }, tx.status);
      log.info(`Sent ${amount} ${anchor.code} to anchor for withdrawal ${w.anchorTxId} (${hash})`);
    } catch (err) {
      log.error(`Payment to anchor failed for ${w.anchorTxId}`, errorMessage(err));
    }
    return;
  }

  if (tx.status !== w.status) update({}, tx.status);
}

export function startWithdrawalMonitor(deps: MonitorDeps): { stop: () => Promise<void> } {
  let running = true;
  const loop = async () => {
    while (running) {
      for (const record of deps.store.pendingWithdrawals()) {
        if (!running) break;
        await checkWithdrawal(record, deps);
      }
      await sleepWhile(deps.pollIntervalMs, () => running);
    }
  };
  const done = loop();
  return {
    stop: async () => {
      running = false;
      await done;
    },
  };
}
