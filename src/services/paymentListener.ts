import type { Horizon } from '@stellar/stellar-sdk';
import type { AnchorConfig, AssetRef, RewardEvent, RewardSource } from '../types';
import { toStroops } from '../utils/amount';
import { logger as rootLogger, errorMessage } from '../utils/logger';
import { sleepWhile } from '../utils/retry';
import { assetKey } from '../config/anchors';

const log = rootLogger.child('listener');

type PaymentLike = Horizon.ServerApi.OperationRecord;

export interface RewardFilter {
  publicKey: string;
  rewardAssets: AssetRef[];
  minRewardAmount: string;
  dripsSenders: string[];
  bountySenders: string[];
  requireKnownSender: boolean;
  anchors: Record<string, AnchorConfig>;
}

export type Classification = { event: RewardEvent } | { skip: string };

/**
 * Decide whether a Horizon payment operation is a reward AutoFi should route.
 * Pure function — all the business rules for "what counts as a reward" live here.
 */
export function classifyPayment(op: PaymentLike, f: RewardFilter): Classification {
  if (!['payment', 'path_payment_strict_send', 'path_payment_strict_receive'].includes(op.type)) {
    return { skip: `operation type ${op.type}` };
  }
  const p = op as PaymentLike & {
    from: string; to: string; amount: string;
    asset_type: string; asset_code?: string; asset_issuer?: string;
  };
  if (!op.transaction_successful) return { skip: 'transaction failed' };
  if (p.to !== f.publicKey) return { skip: 'outgoing payment' };
  // Our own swaps are path payments to ourselves — never re-route them.
  if (p.from === f.publicKey) return { skip: 'self payment (own swap)' };

  const anchorIssuers = new Set(Object.values(f.anchors).map((a) => a.issuer));
  if (anchorIssuers.has(p.from)) return { skip: 'payment from an anchor (refund/deposit)' };

  const asset: AssetRef = p.asset_type === 'native' ? { code: 'XLM' } : { code: p.asset_code!, issuer: p.asset_issuer };
  if (!f.rewardAssets.some((a) => assetKey(a) === assetKey(asset))) {
    return { skip: `asset ${asset.code} is not a reward asset` };
  }
  if (toStroops(p.amount) < toStroops(f.minRewardAmount)) {
    return { skip: `amount ${p.amount} below minimum ${f.minRewardAmount}` };
  }

  let source: RewardSource = 'manual';
  if (f.dripsSenders.includes(p.from)) source = 'drips';
  else if (f.bountySenders.includes(p.from)) source = 'github_bounty';
  else if (f.requireKnownSender) return { skip: `sender ${p.from} is not a known payout address` };

  return {
    event: {
      id: op.id,
      txHash: op.transaction_hash,
      developerPublicKey: f.publicKey,
      from: p.from,
      amount: p.amount,
      asset,
      source,
      receivedAt: op.created_at,
    },
  };
}

export interface ListenerDeps {
  server: Horizon.Server;
  filter: RewardFilter;
  getCursor: () => string | undefined;
  setCursor: (cursor: string) => void;
  startCursor: string;
  onReward: (event: RewardEvent) => Promise<void>;
  pollIntervalMs?: number;
}

/**
 * Watches the developer's account for incoming payments via Horizon, with a
 * persisted cursor so nothing is missed or replayed across restarts.
 * Payments are handled one at a time, in ledger order.
 *
 * This is source-agnostic: Drips Wave payouts, GitHub bounty payouts and
 * manual transfers all arrive as on-chain payments. Configure
 * DRIPS_SENDERS / BOUNTY_SENDERS to label (or restrict) where they come from.
 */
export interface ListenerStatus {
  /** ISO time of the last successful Horizon poll, if any. */
  lastSuccessAt?: string;
  lastError?: string;
}

export function startPaymentListener(deps: ListenerDeps): { stop: () => Promise<void>; status: () => ListenerStatus } {
  const { server, filter, onReward, pollIntervalMs = 5000 } = deps;
  let running = true;
  const state: ListenerStatus = {};

  const initCursor = async (): Promise<string> => {
    const saved = deps.getCursor();
    if (saved) return saved;
    if (deps.startCursor !== 'now') return deps.startCursor;
    // Start from the latest existing payment so history isn't replayed.
    const page = await server.payments().forAccount(filter.publicKey).order('desc').limit(1).call();
    const cursor = page.records[0]?.paging_token ?? '0';
    deps.setCursor(cursor);
    return cursor;
  };

  const loop = async () => {
    let cursor: string | undefined;
    log.info(`Watching ${filter.publicKey} for rewards in ${filter.rewardAssets.map((a) => a.code).join(', ')}`);

    while (running) {
      try {
        cursor ??= await initCursor();
        const page = await server.payments().forAccount(filter.publicKey).cursor(cursor).order('asc').limit(50).call();

        for (const op of page.records) {
          if (!running) break;
          const c = classifyPayment(op, filter);
          if ('event' in c) {
            log.info(`Reward detected: ${c.event.amount} ${c.event.asset.code} from ${c.event.from} (${c.event.source})`);
            await onReward(c.event);
          } else {
            log.debug(`Ignoring op ${op.id}: ${c.skip}`);
          }
          cursor = op.paging_token;
          deps.setCursor(cursor);
        }

        state.lastSuccessAt = new Date().toISOString();
        state.lastError = undefined;
        if (page.records.length === 50) continue; // more to drain
      } catch (err) {
        state.lastError = errorMessage(err);
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 404) {
          log.warn(`Account ${filter.publicKey} not found on this network yet — fund it to start receiving rewards`);
        } else {
          log.error('Polling Horizon failed', errorMessage(err));
        }
      }
      await sleepWhile(pollIntervalMs, () => running);
    }
  };

  const done = loop();
  return {
    status: () => ({ ...state }),
    stop: async () => {
      running = false;
      await done;
    },
  };
}

/**
 * Healthy if Horizon answered within `staleMs`. Before the first success we
 * allow a start-up grace period of the same length.
 */
export function listenerHealth(status: ListenerStatus, startedAt: number, now: number, staleMs: number) {
  const last = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : undefined;
  const ok = last !== undefined ? now - last <= staleMs : now - startedAt <= staleMs;
  return { ok, horizon: { lastSuccessAt: status.lastSuccessAt ?? null, lastError: status.lastError ?? null } };
}
