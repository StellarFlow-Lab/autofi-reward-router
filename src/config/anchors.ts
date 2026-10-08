import type { AnchorConfig, AssetRef, FiatCurrency } from '../types';
import type { StellarNetwork } from './env';

/** Circle USDC issuers. */
export const USDC_ISSUER: Record<StellarNetwork, string> = {
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
};

/** Stellar's public SEP-24 reference anchor — lets you test the whole flow on testnet. */
export const TESTNET_SRT_ANCHOR: AnchorConfig = {
  code: 'SRT',
  issuer: 'GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B',
  homeDomain: 'testanchor.stellar.org',
  currency: 'USD',
};

interface AnchorTemplate {
  code: string;
  currency: FiatCurrency;
  defaultHomeDomain: string;
  defaultIssuer?: Partial<Record<StellarNetwork, string>>;
}

const TEMPLATES: AnchorTemplate[] = [
  { code: 'NGNX', currency: 'NGN', defaultHomeDomain: 'ngnx.io' },
  { code: 'USDC', currency: 'USD', defaultHomeDomain: 'circle.com', defaultIssuer: USDC_ISSUER },
  { code: 'GBPT', currency: 'GBP', defaultHomeDomain: 'poundtoken.io' },
];

/**
 * Build the anchor registry. An anchor is only enabled when it has an issuer,
 * either built-in (USDC) or via `<CODE>_ISSUER`. The home domain (where the
 * SEP-1 stellar.toml and SEP-24 server live) can be overridden with
 * `<CODE>_HOME_DOMAIN`.
 */
export function buildAnchors(
  network: StellarNetwork,
  env: Record<string, string | undefined>,
): Record<string, AnchorConfig> {
  const anchors: Record<string, AnchorConfig> = {};

  for (const t of TEMPLATES) {
    const issuer = env[`${t.code}_ISSUER`]?.trim() || t.defaultIssuer?.[network];
    if (!issuer) continue;
    anchors[t.code] = {
      code: t.code,
      issuer,
      currency: t.currency,
      homeDomain: env[`${t.code}_HOME_DOMAIN`]?.trim() || t.defaultHomeDomain,
    };
  }

  if (network === 'testnet') {
    anchors[TESTNET_SRT_ANCHOR.code] = { ...TESTNET_SRT_ANCHOR };
  }

  return anchors;
}

/**
 * Parse a comma-separated asset list: `XLM`, `native`, `CODE:ISSUER`, or a bare
 * `USDC` (resolved to Circle's issuer for the network).
 */
export function parseAssetList(raw: string, network: StellarNetwork): AssetRef[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      if (/^(xlm|native)$/i.test(token)) return { code: 'XLM' };
      const [code, issuer] = token.split(':');
      if (issuer) return { code, issuer };
      if (code.toUpperCase() === 'USDC') return { code: 'USDC', issuer: USDC_ISSUER[network] };
      throw new Error(`Asset "${token}" needs an issuer (use CODE:ISSUER)`);
    });
}

export function assetKey(asset: AssetRef): string {
  return asset.issuer ? `${asset.code}:${asset.issuer}` : 'XLM';
}
