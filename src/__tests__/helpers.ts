import { Keypair } from '@stellar/stellar-sdk';
import type { AnchorConfig, RewardEvent } from '../types';

export const DEV = Keypair.random();
export const SENDER = Keypair.random().publicKey();
export const NGNX_ISSUER = Keypair.random().publicKey();
export const USDC_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export const ANCHORS: Record<string, AnchorConfig> = {
  NGNX: { code: 'NGNX', issuer: NGNX_ISSUER, homeDomain: 'ngnx.example', currency: 'NGN' },
  USDC: { code: 'USDC', issuer: USDC_TESTNET, homeDomain: 'usdc.example', currency: 'USD' },
};

export function rewardEvent(overrides: Partial<RewardEvent> = {}): RewardEvent {
  return {
    id: `op-${Math.random().toString(36).slice(2)}`,
    txHash: 'a'.repeat(64),
    developerPublicKey: DEV.publicKey(),
    from: SENDER,
    amount: '100.0000000',
    asset: { code: 'USDC', issuer: USDC_TESTNET },
    source: 'drips',
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function silenceLogs() {
  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());
}
