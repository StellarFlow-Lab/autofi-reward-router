import { createRewardProcessor, type ProcessorDeps } from '../core/rewardProcessor';
import { StateStore } from '../services/stateStore';
import { NoPathError, type Wallet } from '../services/stellarWallet';
import type { AnchorClient } from '../services/anchorClient';
import { MetricsCollector } from '../utils/metrics';
import type { AnchorConfig, AssetRef, RoutePreferences } from '../types';
import { ANCHORS, NGNX_ISSUER, rewardEvent, silenceLogs } from './helpers';

silenceLogs();

const ngnxPrefs: RoutePreferences = { offRampPct: 70, keepCryptoPct: 30, anchorAssetCode: 'NGNX', anchorIssuer: NGNX_ISSUER };

function setup(over: Partial<ProcessorDeps> & { prefs?: RoutePreferences | null } = {}) {
  const wallet: jest.Mocked<Wallet> = {
    publicKey: 'G',
    quote: jest.fn(),
    swap: jest.fn(async (_s: AssetRef, amount: string, _d: AssetRef) => ({ sendAmount: amount, destAmount: '110000.0000000', destMin: '107800.0000000', path: [], txHash: 'swaphash', received: '109000.0000000' })),
    pay: jest.fn(),
  };
  const anchorClient: jest.Mocked<AnchorClient> = {
    startWithdrawal: jest.fn(async (_a: AnchorConfig, _amt: string) => ({ id: 'anchor-tx-1', url: 'https://ngnx.example/kyc' })),
    getTransaction: jest.fn(),
  };
  const store = StateStore.inMemory();
  const metrics = new MetricsCollector();
  const prefs = over.prefs === undefined ? ngnxPrefs : over.prefs;
  const deps: ProcessorDeps = {
    preferences: { getPreferences: jest.fn(async () => prefs) },
    wallet, anchors: ANCHORS, anchorClient, store, metrics, dryRun: false,
    ...over,
  };
  return { process: createRewardProcessor(deps), wallet, anchorClient, store, metrics };
}

describe('reward processor', () => {
  test('happy path: split, swap, open withdrawal', async () => {
    const { process, wallet, anchorClient, metrics } = setup();
    const rec = await process(rewardEvent({ amount: '100' }));

    expect(wallet.swap).toHaveBeenCalledWith(expect.objectContaining({ code: 'USDC' }), '70.0000000', { code: 'NGNX', issuer: NGNX_ISSUER });
    expect(anchorClient.startWithdrawal).toHaveBeenCalledWith(ANCHORS.NGNX, '109000.0000000');
    expect(rec).toMatchObject({
      status: 'withdrawal_pending', offRampAmount: '70.0000000', destAmount: '109000.0000000', swapTxHash: 'swaphash',
      withdrawal: { anchorTxId: 'anchor-tx-1', interactiveUrl: 'https://ngnx.example/kyc' },
    });
    expect(metrics.getMetrics()).toMatchObject({ successfulSwaps: 1, withdrawalsStarted: 1, offRampedByAsset: { USDC: '70.0000000' } });
  });

  test('is idempotent per payment id', async () => {
    const { process, wallet } = setup();
    const e = rewardEvent();
    await process(e);
    await process(e);
    expect(wallet.swap).toHaveBeenCalledTimes(1);
  });

  test('never retries a reward interrupted mid-swap', async () => {
    const { process, wallet, store } = setup();
    const e = rewardEvent();
    store.upsert({ eventId: e.id, rewardTxHash: e.txHash, developerPublicKey: e.developerPublicKey, source: 'drips', receivedAmount: e.amount, receivedAsset: 'USDC', status: 'processing', dryRun: false });
    const rec = await process(e);
    expect(rec.status).toBe('failed');
    expect(rec.reason).toMatch(/interrupted/);
    expect(wallet.swap).not.toHaveBeenCalled();
  });

  test('skips when no preferences and when keeping 100% crypto', async () => {
    const a = setup({ prefs: null });
    expect((await a.process(rewardEvent())).status).toBe('skipped');
    const b = setup({ prefs: { ...ngnxPrefs, offRampPct: 0, keepCryptoPct: 100 } });
    expect((await b.process(rewardEvent())).reason).toMatch(/100% in crypto/);
    expect(b.wallet.swap).not.toHaveBeenCalled();
  });

  test('fails safely on unknown anchor or issuer mismatch', async () => {
    const a = setup({ prefs: { ...ngnxPrefs, anchorAssetCode: 'GBPT' } });
    expect((await a.process(rewardEvent())).reason).toMatch(/not enabled/);
    const b = setup({ prefs: { ...ngnxPrefs, anchorIssuer: ANCHORS.USDC.issuer } });
    expect((await b.process(rewardEvent())).reason).toMatch(/doesn't match/);
    expect(b.wallet.swap).not.toHaveBeenCalled();
  });

  test('records swap failures without throwing', async () => {
    const { process, wallet, metrics } = setup();
    wallet.swap.mockRejectedValueOnce(new NoPathError('No DEX path'));
    const rec = await process(rewardEvent());
    expect(rec).toMatchObject({ status: 'failed', reason: 'No DEX path', offRampAmount: '70.0000000' });
    expect(metrics.getMetrics().failedSwaps).toBe(1);
  });

  test('keeps the swap when the anchor is unreachable', async () => {
    const { process, anchorClient } = setup();
    anchorClient.startWithdrawal.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const rec = await process(rewardEvent());
    expect(rec.status).toBe('swapped');
    expect(rec.reason).toMatch(/withdrawal not started/);
  });

  test('dry run never opens a withdrawal', async () => {
    const { process, anchorClient } = setup({ dryRun: true });
    const rec = await process(rewardEvent());
    expect(rec).toMatchObject({ status: 'swapped', dryRun: true });
    expect(anchorClient.startWithdrawal).not.toHaveBeenCalled();
  });
});
