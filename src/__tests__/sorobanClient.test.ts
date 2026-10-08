import { Keypair } from '@stellar/stellar-sdk';
import { FallbackPreferencesProvider, parsePreferences } from '../services/sorobanClient';
import { silenceLogs } from './helpers';

silenceLogs();
const issuer = Keypair.random().publicKey();

describe('preferences', () => {
  test('parses the contract struct', () => {
    expect(parsePreferences({ off_ramp_pct: 70, keep_crypto_pct: 30, anchor_asset_code: 'ngnx', anchor_issuer: issuer }))
      .toEqual({ offRampPct: 70, keepCryptoPct: 30, anchorAssetCode: 'NGNX', anchorIssuer: issuer });
  });

  test('rejects bad on-chain data', () => {
    expect(() => parsePreferences({ off_ramp_pct: 80, keep_crypto_pct: 30, anchor_asset_code: 'X', anchor_issuer: issuer })).toThrow(/split/);
    expect(() => parsePreferences({ off_ramp_pct: 50, keep_crypto_pct: 50, anchor_asset_code: 'X', anchor_issuer: 'CABC' })).toThrow(/issuer/);
  });

  test('falls back to defaults when the contract has nothing', async () => {
    const defaults = { offRampPct: 100, keepCryptoPct: 0, anchorAssetCode: 'USDC', anchorIssuer: issuer };
    const onChain = { ...defaults, offRampPct: 60, keepCryptoPct: 40 };
    const primary = { getPreferences: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(onChain) };
    const p = new FallbackPreferencesProvider(primary, defaults);
    expect(await p.getPreferences('G')).toEqual(defaults);
    expect(await p.getPreferences('G')).toEqual(onChain);
    expect(await new FallbackPreferencesProvider(null, undefined).getPreferences('G')).toBeNull();
  });
});
