import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { RoutePreferences } from '../types';
import { logger as rootLogger } from '../utils/logger';
import { retryAsync } from '../utils/retry';
import { validatePercentageSplit, validateStellarPublicKey } from '../utils/validation';

const log = rootLogger.child('soroban');

export interface PreferencesProvider {
  /** Returns null when the developer hasn't stored preferences. */
  getPreferences(developer: string): Promise<RoutePreferences | null>;
}

/**
 * Read-only client for the reward_router contract. Reads are done with
 * simulateTransaction, so they cost nothing and need no signature.
 */
export class SorobanPreferencesClient implements PreferencesProvider {
  private readonly server: rpc.Server;
  private readonly contract: Contract;

  constructor(
    rpcUrl: string,
    contractId: string,
    private readonly networkPassphrase: string,
    private readonly sourcePublicKey: string,
  ) {
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.contract = new Contract(contractId);
  }

  private async read(method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    return retryAsync(
      async () => {
        const tx = new TransactionBuilder(new Account(this.sourcePublicKey, '0'), {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(this.contract.call(method, ...args))
          .setTimeout(30)
          .build();

        const sim = await this.server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(sim)) {
          throw new ContractCallError(`${method} failed: ${sim.error}`);
        }
        if (!sim.result) throw new ContractCallError(`${method} returned no result`);
        return scValToNative(sim.result.retval);
      },
      // A contract error won't fix itself — only retry transport problems.
      { retries: 2, label: `soroban.${method}`, logger: log, shouldRetry: (e) => !(e instanceof ContractCallError) },
    );
  }

  async hasPreferences(developer: string): Promise<boolean> {
    return Boolean(await this.read('has_preferences', new Address(developer).toScVal()));
  }

  async getPreferences(developer: string): Promise<RoutePreferences | null> {
    if (!(await this.hasPreferences(developer))) return null;
    const raw = await this.read('get_preferences', new Address(developer).toScVal());
    return parsePreferences(raw);
  }
}

export class ContractCallError extends Error {
  name = 'ContractCallError';
}

/** Convert the contract's RoutePreferences struct into our TS shape, validating it. */
export function parsePreferences(raw: unknown): RoutePreferences {
  const r = raw as Record<string, unknown>;
  const toStr = (v: unknown) =>
    typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v).toString('utf-8') : String(v);
  const prefs: RoutePreferences = {
    offRampPct: Number(r?.off_ramp_pct),
    keepCryptoPct: Number(r?.keep_crypto_pct),
    anchorAssetCode: toStr(r?.anchor_asset_code).toUpperCase(),
    anchorIssuer: toStr(r?.anchor_issuer),
  };
  if (!validatePercentageSplit(prefs.offRampPct, prefs.keepCryptoPct)) {
    throw new Error(`Invalid on-chain split ${prefs.offRampPct}/${prefs.keepCryptoPct}`);
  }
  if (!validateStellarPublicKey(prefs.anchorIssuer)) {
    throw new Error(`Invalid on-chain anchor issuer "${prefs.anchorIssuer}"`);
  }
  return prefs;
}

/** Tries the contract first, then falls back to static defaults from config. */
export class FallbackPreferencesProvider implements PreferencesProvider {
  constructor(
    private readonly primary: PreferencesProvider | null,
    private readonly fallback: RoutePreferences | undefined,
  ) {}

  async getPreferences(developer: string): Promise<RoutePreferences | null> {
    if (this.primary) {
      const prefs = await this.primary.getPreferences(developer);
      if (prefs) return prefs;
      log.info(`No on-chain preferences for ${developer}${this.fallback ? ', using defaults' : ''}`);
    }
    return this.fallback ? { ...this.fallback } : null;
  }
}
