import { alertText, createAlerter } from '../services/alerter';
import type { RewardRecord } from '../types';
import { silenceLogs } from './helpers';

silenceLogs();

const record = (over: Partial<RewardRecord>): RewardRecord => ({
  eventId: 'e1', rewardTxHash: 'h', developerPublicKey: 'G', source: 'drips', receivedAmount: '10', receivedAsset: 'USDC',
  status: 'processing', dryRun: false, createdAt: '', updatedAt: '', ...over,
});

describe('alerts', () => {
  test('only failures, cash-out links and completions are announced', () => {
    expect(alertText(record({ status: 'failed', reason: 'no path' }), 'testnet')).toMatch(/failed — no path/);
    expect(alertText(record({ status: 'completed', destAmount: '7', destAsset: 'NGNX' }), 'testnet')).toMatch(/payout complete — 7 NGNX/);
    expect(
      alertText(record({ status: 'withdrawal_pending', destAmount: '7', destAsset: 'NGNX', withdrawal: { anchorTxId: 'a', homeDomain: 'x', interactiveUrl: 'https://anchor/kyc', status: 'incomplete', updatedAt: '' } }), 'testnet'),
    ).toMatch(/https:\/\/anchor\/kyc/);
    for (const status of ['processing', 'swapped', 'skipped'] as const) {
      expect(alertText(record({ status }), 'testnet')).toBeNull();
    }
  });

  test('posts Slack- and Discord-compatible JSON, and ignores webhook errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const alert = createAlerter({ url: 'https://hooks.example/x', network: 'testnet', fetchImpl: fetchImpl as unknown as typeof fetch });

    alert(record({ status: 'processing' }), undefined);
    expect(fetchImpl).not.toHaveBeenCalled();

    alert(record({ status: 'failed', reason: 'boom' }), 'processing');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://hooks.example/x');
    const body = JSON.parse(init.body);
    expect(body.text).toMatch(/boom/);
    expect(body.content).toBe(body.text);

    const failing = jest.fn().mockRejectedValue(new Error('down'));
    const quiet = createAlerter({ url: 'https://hooks.example/x', network: 'testnet', fetchImpl: failing as unknown as typeof fetch });
    expect(() => quiet(record({ status: 'failed' }), 'processing')).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
