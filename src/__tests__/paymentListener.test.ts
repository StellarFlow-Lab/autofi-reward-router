import { Keypair, type Horizon } from '@stellar/stellar-sdk';
import { classifyPayment, type RewardFilter, listenerHealth } from '../services/paymentListener';
import { ANCHORS, DEV, NGNX_ISSUER, SENDER, USDC_TESTNET } from './helpers';

const filter: RewardFilter = {
  publicKey: DEV.publicKey(),
  rewardAssets: [{ code: 'USDC', issuer: USDC_TESTNET }, { code: 'XLM' }],
  minRewardAmount: '1',
  dripsSenders: [SENDER],
  bountySenders: [],
  requireKnownSender: false,
  anchors: ANCHORS,
};

function op(o: Record<string, unknown> = {}) {
  return {
    id: '123', paging_token: '123', type: 'payment', transaction_successful: true,
    transaction_hash: 'h', created_at: '2026-01-01T00:00:00Z',
    from: SENDER, to: DEV.publicKey(), amount: '50.0000000',
    asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_TESTNET,
    ...o,
  } as unknown as Horizon.ServerApi.OperationRecord;
}

describe('classifyPayment', () => {
  test('accepts a USDC payout from a known Drips sender', () => {
    const r = classifyPayment(op(), filter);
    expect('event' in r && r.event).toMatchObject({ id: '123', amount: '50.0000000', source: 'drips', asset: { code: 'USDC' } });
  });

  test('accepts native XLM and labels unknown senders as manual', () => {
    const stranger = Keypair.random().publicKey();
    const r = classifyPayment(op({ asset_type: 'native', asset_code: undefined, asset_issuer: undefined, from: stranger }), filter);
    expect('event' in r && r.event.source).toBe('manual');
    expect('event' in r && r.event.asset).toEqual({ code: 'XLM' });
  });

  test.each([
    ['our own swap', { from: DEV.publicKey(), type: 'path_payment_strict_send' }, /self payment/],
    ['outgoing', { to: SENDER }, /outgoing/],
    ['failed tx', { transaction_successful: false }, /failed/],
    ['wrong asset', { asset_code: 'EURC' }, /not a reward asset/],
    ['dust', { amount: '0.5' }, /below minimum/],
    ['anchor refund', { from: NGNX_ISSUER }, /anchor/],
    ['non-payment', { type: 'create_account' }, /operation type/],
  ])('skips %s', (_name, o, reason) => {
    const r = classifyPayment(op(o), filter);
    expect('skip' in r && r.skip).toMatch(reason as RegExp);
  });

  test('requireKnownSender rejects strangers', () => {
    const r = classifyPayment(op({ from: Keypair.random().publicKey() }), { ...filter, requireKnownSender: true });
    expect('skip' in r && r.skip).toMatch(/not a known payout address/);
  });
});

describe('listenerHealth', () => {
  const STALE = 120_000;
  const t0 = Date.parse('2026-01-01T00:00:00Z');

  test('healthy during start-up grace, unhealthy if Horizon never answers', () => {
    expect(listenerHealth({}, t0, t0 + 60_000, STALE).ok).toBe(true);
    const h = listenerHealth({ lastError: 'Forbidden' }, t0, t0 + 180_000, STALE);
    expect(h.ok).toBe(false);
    expect(h.horizon.lastError).toBe('Forbidden');
  });

  test('tracks the last successful poll', () => {
    const recent = { lastSuccessAt: new Date(t0 + 500_000).toISOString() };
    expect(listenerHealth(recent, t0, t0 + 560_000, STALE).ok).toBe(true);
    expect(listenerHealth(recent, t0, t0 + 700_000, STALE).ok).toBe(false);
  });
});
