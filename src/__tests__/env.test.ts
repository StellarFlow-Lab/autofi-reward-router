import { Keypair, Networks, StrKey } from '@stellar/stellar-sdk';
import { ConfigError, loadConfig } from '../config/env';
import { USDC_ISSUER } from '../config/anchors';

const secret = Keypair.random().secret();
const contract = StrKey.encodeContract(Buffer.alloc(32, 1));

describe('loadConfig', () => {
  test('minimal testnet config with defaults', () => {
    const c = loadConfig({ DEV_PRIVATE_KEY: secret, DEFAULT_ANCHOR: 'srt', DEFAULT_OFF_RAMP_PCT: '70' });
    expect(c.network).toBe('testnet');
    expect(c.networkPassphrase).toBe(Networks.TESTNET);
    expect(c.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    expect(c.defaultPreferences).toMatchObject({ offRampPct: 70, keepCryptoPct: 30, anchorAssetCode: 'SRT' });
    expect(c.anchors.USDC.issuer).toBe(USDC_ISSUER.testnet);
    expect(c.anchors.NGNX).toBeUndefined(); // no issuer configured → disabled
    expect(c.rewardAssets).toEqual([{ code: 'USDC', issuer: USDC_ISSUER.testnet }, { code: 'XLM' }]);
    expect(c.slippageBps).toBe(200);
    expect(c.dryRun).toBe(false);
  });

  test('CORS_ORIGIN must be a bare origin', () => {
    const base = { DEV_PRIVATE_KEY: secret, DEFAULT_ANCHOR: 'SRT' };
    expect(loadConfig({ ...base, CORS_ORIGIN: 'https://app.example.com' }).corsOrigin).toBe('https://app.example.com');
    expect(loadConfig(base).corsOrigin).toBeUndefined();
    for (const bad of ['https://app.example.com/', 'https://app.example.com/web', 'app.example.com', '*']) {
      expect(() => loadConfig({ ...base, CORS_ORIGIN: bad })).toThrow(/CORS_ORIGIN/);
    }
  });

  test('mainnet requires a strong ADMIN_TOKEN', () => {
    const base = { STELLAR_NETWORK: 'mainnet', DEV_PRIVATE_KEY: secret, DEFAULT_ANCHOR: 'USDC' };
    expect(() => loadConfig(base)).toThrow(/ADMIN_TOKEN is required on mainnet/);
    expect(() => loadConfig({ ...base, ADMIN_TOKEN: 'short' })).toThrow(/at least 24 characters/);
    expect(loadConfig({ ...base, ADMIN_TOKEN: 'a'.repeat(24) }).adminToken).toBe('a'.repeat(24));
    // testnet still runs without one, for local development
    expect(loadConfig({ DEV_PRIVATE_KEY: secret, DEFAULT_ANCHOR: 'SRT' }).adminToken).toBeUndefined();
  });

  test('mainnet uses mainnet USDC and has no SRT', () => {
    const c = loadConfig({ STELLAR_NETWORK: 'mainnet', DEV_PRIVATE_KEY: secret, DEFAULT_ANCHOR: 'USDC', ADMIN_TOKEN: 'x'.repeat(24) });
    expect(c.anchors.USDC.issuer).toBe(USDC_ISSUER.mainnet);
    expect(c.anchors.SRT).toBeUndefined();
  });

  test('collects every problem at once', () => {
    try {
      loadConfig({ STELLAR_NETWORK: 'devnet', DEV_PRIVATE_KEY: 'nope', SLIPPAGE_BPS: 'lots', NGNX_ISSUER: 'bad' });
      fail('expected ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems.join('\n');
      expect(problems).toMatch(/STELLAR_NETWORK/);
      expect(problems).toMatch(/DEV_PRIVATE_KEY/);
      expect(problems).toMatch(/SLIPPAGE_BPS/);
      expect(problems).toMatch(/NGNX_ISSUER/);
      expect(problems).toMatch(/REWARD_ROUTER_CONTRACT_ID, or DEFAULT_ANCHOR/);
    }
  });

  test('SLIPPAGE_TOLERANCE_PCT still works; SLIPPAGE_BPS wins when both are set', () => {
    expect(loadConfig({ DEV_PRIVATE_KEY: secret, DEFAULT_ANCHOR: 'USDC', SLIPPAGE_TOLERANCE_PCT: '1' }).slippageBps).toBe(100);
    expect(loadConfig({ DEV_PRIVATE_KEY: secret, DEFAULT_ANCHOR: 'USDC', SLIPPAGE_TOLERANCE_PCT: '1', SLIPPAGE_BPS: '50' }).slippageBps).toBe(50);
    expect(() => loadConfig({ DEV_PRIVATE_KEY: secret, DEFAULT_ANCHOR: 'USDC', SLIPPAGE_TOLERANCE_PCT: '-1' })).toThrow(/SLIPPAGE_TOLERANCE_PCT/);
  });

  test('mismatched public key is rejected', () => {
    expect(() =>
      loadConfig({ DEV_PRIVATE_KEY: secret, DEV_PUBLIC_KEY: Keypair.random().publicKey(), DEFAULT_ANCHOR: 'USDC' }),
    ).toThrow(/does not match/);
  });

  test('contract on mainnet needs an explicit RPC url', () => {
    expect(() => loadConfig({ STELLAR_NETWORK: 'mainnet', DEV_PRIVATE_KEY: secret, REWARD_ROUTER_CONTRACT_ID: contract }))
      .toThrow(/SOROBAN_RPC_URL/);
    const c = loadConfig({ STELLAR_NETWORK: 'mainnet', DEV_PRIVATE_KEY: secret, REWARD_ROUTER_CONTRACT_ID: contract, SOROBAN_RPC_URL: 'https://rpc.example', ADMIN_TOKEN: 'a'.repeat(24) });
    expect(c.contractId).toBe(contract);
  });

  test('custom reward assets and anchor overrides', () => {
    const issuer = Keypair.random().publicKey();
    const c = loadConfig({
      DEV_PRIVATE_KEY: secret, DEFAULT_ANCHOR: 'NGNX', NGNX_ISSUER: issuer, NGNX_HOME_DOMAIN: 'anchor.ng',
      REWARD_ASSETS: `native, EURC:${issuer}`, DRY_RUN: 'yes',
    });
    expect(c.anchors.NGNX).toEqual({ code: 'NGNX', issuer, homeDomain: 'anchor.ng', currency: 'NGN' });
    expect(c.rewardAssets).toEqual([{ code: 'XLM' }, { code: 'EURC', issuer }]);
    expect(c.dryRun).toBe(true);
  });
});
