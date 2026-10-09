import type { RewardRecord } from '../types';
import type { TransitionListener } from './stateStore';
import { logger as rootLogger, errorMessage } from '../utils/logger';

const log = rootLogger.child('alerts');

export interface AlerterOptions {
  /** Incoming-webhook URL (Slack, Discord, or anything accepting a JSON POST). */
  url: string;
  network: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Text for a status change worth telling a human about, or null to stay quiet. */
export function alertText(record: RewardRecord, network: string): string | null {
  const reward = `${record.receivedAmount} ${record.receivedAsset} (${record.source}, ${network})`;
  switch (record.status) {
    case 'failed':
      return `❌ AutoFi: reward ${reward} failed — ${record.reason ?? 'unknown reason'}. Event ${record.eventId}.`;
    case 'withdrawal_pending':
      return record.withdrawal
        ? `🏦 AutoFi: ${record.destAmount} ${record.destAsset} ready to cash out. Finish the payout here (KYC may be needed): ${record.withdrawal.interactiveUrl}`
        : null;
    case 'completed':
      return `✅ AutoFi: payout complete — ${record.destAmount} ${record.destAsset} from reward ${reward}.`;
    default:
      return null;
  }
}

/**
 * Posts alerts to a webhook. Fire-and-forget: a slow or broken webhook never
 * blocks or fails reward processing. Sends both `text` (Slack) and `content`
 * (Discord) so either works without configuration.
 */
export function createAlerter(opts: AlerterOptions): TransitionListener {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  return (record) => {
    const text = alertText(record, opts.network);
    if (!text) return;
    doFetch(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text, event: record.eventId, status: record.status }),
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((res) => {
        if (!res.ok) log.warn(`Alert webhook returned HTTP ${res.status}`);
      })
      .catch((err) => log.warn('Alert webhook failed', errorMessage(err)));
  };
}
