import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

export const NETWORK_PASSPHRASE = Networks.TESTNET;

/** A routing rule as stored in the reward_router contract. */
export interface RoutePreferences {
  offRampPct: number;
  keepCryptoPct: number;
  anchorAssetCode: string;
  anchorIssuer: string;
}

/** Anchors the app offers on testnet. NGNX uses whatever issuer you enter. */
export const TESTNET_ANCHORS: Array<{ code: string; issuer?: string; label: string }> = [
  { code: 'SRT', issuer: 'GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B', label: 'SRT — Stellar test anchor (USD)' },
  { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', label: 'USDC — Circle testnet (USD)' },
  { code: 'NGNX', label: 'NGNX — Naira (enter issuer)' },
];

/** Encode prefs as the contract's struct: a map with fields in alphabetical order. */
export function encodePrefs(p: RoutePreferences): xdr.ScVal {
  const field = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  return xdr.ScVal.scvMap([
    field('anchor_asset_code', nativeToScVal(p.anchorAssetCode, { type: 'string' })),
    field('anchor_issuer', new Address(p.anchorIssuer).toScVal()),
    field('keep_crypto_pct', nativeToScVal(p.keepCryptoPct, { type: 'u32' })),
    field('off_ramp_pct', nativeToScVal(p.offRampPct, { type: 'u32' })),
  ]);
}

/** Same checks the contract enforces, so users get a clear message before signing. */
export function validatePrefs(p: RoutePreferences): string | null {
  if (!Number.isInteger(p.offRampPct) || p.offRampPct < 0 || p.offRampPct > 100) return 'Off-ramp share must be 0–100%.';
  if (p.offRampPct + p.keepCryptoPct !== 100) return 'Shares must add up to 100%.';
  if (p.anchorAssetCode.length < 1 || p.anchorAssetCode.length > 12) return 'Asset code must be 1–12 characters.';
  if (!StrKey.isValidEd25519PublicKey(p.anchorIssuer)) return 'Issuer must be a valid Stellar address (G…).';
  return null;
}

export class ContractClient {
  private readonly server: rpc.Server;
  private readonly contract: Contract;

  constructor(rpcUrl: string, contractId: string) {
    if (!StrKey.isValidContract(contractId)) throw new Error('Contract ID must start with C and be 56 characters.');
    this.server = new rpc.Server(rpcUrl);
    this.contract = new Contract(contractId);
  }

  /** Read-only call via simulation: free, no signature. */
  private async read(method: string, source: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(source, '0'), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`);
    if (!sim.result) throw new Error(`${method} returned nothing`);
    return scValToNative(sim.result.retval);
  }

  async getPreferences(user: string): Promise<RoutePreferences | null> {
    const has = await this.read('has_preferences', user, new Address(user).toScVal());
    if (!has) return null;
    const raw = (await this.read('get_preferences', user, new Address(user).toScVal())) as Record<string, unknown>;
    return {
      offRampPct: Number(raw.off_ramp_pct),
      keepCryptoPct: Number(raw.keep_crypto_pct),
      anchorAssetCode: String(raw.anchor_asset_code),
      anchorIssuer: String(raw.anchor_issuer),
    };
  }

  /** Build a ready-to-sign transaction (simulated, with fees and footprint). */
  async buildSet(user: string, prefs: RoutePreferences): Promise<string> {
    return this.build(user, this.contract.call('set_preferences', new Address(user).toScVal(), encodePrefs(prefs)));
  }

  async buildRemove(user: string): Promise<string> {
    return this.build(user, this.contract.call('remove_preferences', new Address(user).toScVal()));
  }

  private async build(user: string, op: xdr.Operation): Promise<string> {
    const account = await this.server.getAccount(user);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(op)
      .setTimeout(120)
      .build();
    const prepared = await this.server.prepareTransaction(tx);
    return prepared.toXDR();
  }

  /** Submit a signed transaction and wait for it to land. Returns the hash. */
  async submit(signedXdr: string): Promise<string> {
    const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === 'ERROR') throw new Error('The network rejected the transaction.');
    for (let i = 0; i < 30; i++) {
      const res = await this.server.getTransaction(sent.hash);
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
      if (res.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error('The transaction failed on-chain.');
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Timed out waiting for confirmation.');
  }
}
