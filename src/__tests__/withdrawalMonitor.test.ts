import { checkWithdrawal } from '../core/withdrawalMonitor';
import { StateStore } from '../services/stateStore';
import type { AnchorClient, Sep24Transaction } from '../services/anchorClient';
import type { PaymentRequest, Wallet } from '../services/stellarWallet';
import type { AnchorConfig } from '../types';
import { MetricsCollector } from '../utils/metrics';
import { ANCHORS, silenceLogs } from './helpers';

silenceLogs();

function setup(tx: Partial<Sep24Transaction>, opts: { autoSend?: boolean; createdAt?: string } = {}) {
  const store = StateStore.inMemory();
  const record = store.upsert({
    eventId: 'e1', rewardTxHash: 'r', developerPublicKey: 'G', source: 'drips', receivedAmount: '100', receivedAsset: 'USDC',
    offRampAmount: '70', destAsset: 'NGNX', destAmount: '109000.0000000', swapTxHash: 's', status: 'withdrawal_pending', dryRun: false,
    withdrawal: { anchorTxId: 'w1', homeDomain: 'ngnx.example', interactiveUrl: 'u', status: 'incomplete', updatedAt: '' },
    createdAt: opts.createdAt,
  });
  const anchorClient: jest.Mocked<AnchorClient> = {
    startWithdrawal: jest.fn(),
    getTransaction: jest.fn(async (_a: AnchorConfig, _id: string) => ({ id: 'w1', status: 'pending_user_transfer_start', ...tx }) as Sep24Transaction),
  };
  const wallet: jest.Mocked<Wallet> = { publicKey: 'G', quote: jest.fn(), swap: jest.fn(), pay: jest.fn(async (_r: PaymentRequest): Promise<string | undefined> => 'payhash') };
  const deps = { anchorClient, wallet, store, metrics: new MetricsCollector(), anchors: ANCHORS, autoSend: opts.autoSend ?? true, timeoutMs: 86_400_000 };
  return { run: () => checkWithdrawal(store.get('e1')!, deps), record, store, wallet };
}

const anchorAccount = ANCHORS.USDC.issuer;

describe('withdrawal monitor', () => {
  test('pays the anchor with its memo once the user finishes KYC', async () => {
    const { run, wallet, store } = setup({ withdraw_anchor_account: anchorAccount, withdraw_memo: '42', withdraw_memo_type: 'id', amount_in: '100000' });
    await run();
    expect(wallet.pay).toHaveBeenCalledWith({ to: anchorAccount, asset: { code: 'NGNX', issuer: ANCHORS.NGNX.issuer }, amount: '100000', memo: '42', memoType: 'id' });
    expect(store.get('e1')!.withdrawal!.paymentTxHash).toBe('payhash');

    await run(); // second poll must not pay twice
    expect(wallet.pay).toHaveBeenCalledTimes(1);
  });

  test('refuses to send more than the reward produced', async () => {
    const { run, wallet, store } = setup({ withdraw_anchor_account: anchorAccount, amount_in: '999999' });
    await run();
    expect(wallet.pay).not.toHaveBeenCalled();
    expect(store.get('e1')!.status).toBe('failed');
  });

  test('respects SEP24_AUTO_SEND=false', async () => {
    const { run, wallet } = setup({ withdraw_anchor_account: anchorAccount }, { autoSend: false });
    await run();
    expect(wallet.pay).not.toHaveBeenCalled();
  });

  test('marks completed and failed statuses', async () => {
    const a = setup({ status: 'completed', amount_out: '108000' });
    await a.run();
    expect(a.store.get('e1')!.status).toBe('completed');
    const b = setup({ status: 'refunded', message: 'bank rejected' });
    await b.run();
    expect(b.store.get('e1')!).toMatchObject({ status: 'failed', reason: 'anchor reported refunded: bank rejected' });
  });

  test('times out stale withdrawals', async () => {
    const { run, store } = setup({}, { createdAt: '2020-01-01T00:00:00Z' });
    await run();
    expect(store.get('e1')!.reason).toMatch(/timed out/);
  });
});
