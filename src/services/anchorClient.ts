import { Keypair, StellarToml, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import type { AnchorConfig } from '../types';
import { logger as rootLogger } from '../utils/logger';
import { retryAsync } from '../utils/retry';

const log = rootLogger.child('anchor');

interface AnchorInfo {
  webAuthEndpoint: string;
  signingKey: string;
  transferServer: string;
}

/** Subset of the SEP-24 transaction object we rely on. */
export interface Sep24Transaction {
  id: string;
  kind?: string;
  status: string;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: 'text' | 'id' | 'hash';
  stellar_transaction_id?: string;
  message?: string;
  more_info_url?: string;
}

export interface InteractiveWithdrawal {
  id: string;
  url: string;
}

export interface AnchorClient {
  startWithdrawal(anchor: AnchorConfig, amount: string): Promise<InteractiveWithdrawal>;
  getTransaction(anchor: AnchorConfig, id: string): Promise<Sep24Transaction>;
}

export class HttpError extends Error {
  name = 'HttpError';
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function http<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(`${init.method ?? 'GET'} ${url} → ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const retryable = (e: unknown) => !(e instanceof HttpError) || e.status >= 500 || e.status === 429;

/**
 * SEP-1 discovery + SEP-10 authentication + SEP-24 interactive withdrawals.
 * Works with any compliant anchor; tested against testanchor.stellar.org.
 */
export class Sep24AnchorClient implements AnchorClient {
  private info = new Map<string, AnchorInfo>();
  private tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly keypair: Keypair,
    private readonly networkPassphrase: string,
  ) {}

  /** SEP-1: read the anchor's stellar.toml. */
  async discover(homeDomain: string): Promise<AnchorInfo> {
    const cached = this.info.get(homeDomain);
    if (cached) return cached;

    const toml = await retryAsync(() => StellarToml.Resolver.resolve(homeDomain), {
      retries: 2, label: `stellar.toml ${homeDomain}`, logger: log,
    });
    const info: AnchorInfo = {
      webAuthEndpoint: toml.WEB_AUTH_ENDPOINT as string,
      signingKey: toml.SIGNING_KEY as string,
      transferServer: toml.TRANSFER_SERVER_SEP0024 as string,
    };
    if (!info.webAuthEndpoint || !info.signingKey || !info.transferServer) {
      throw new Error(`${homeDomain} stellar.toml is missing WEB_AUTH_ENDPOINT, SIGNING_KEY or TRANSFER_SERVER_SEP0024 — it doesn't support SEP-24`);
    }
    this.info.set(homeDomain, info);
    return info;
  }

  /** SEP-10: prove control of our account and get a JWT. Cached until expiry. */
  async authenticate(homeDomain: string): Promise<string> {
    const cached = this.tokens.get(homeDomain);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const info = await this.discover(homeDomain);
    const account = this.keypair.publicKey();
    const challenge = await http<{ transaction: string; network_passphrase?: string }>(
      `${info.webAuthEndpoint}?account=${account}&home_domain=${encodeURIComponent(homeDomain)}`,
    );
    if (challenge.network_passphrase && challenge.network_passphrase !== this.networkPassphrase) {
      throw new Error(`${homeDomain} is on a different network (${challenge.network_passphrase})`);
    }

    // Verifies the challenge was really built by the anchor's SIGNING_KEY,
    // targets our account, and has no dangerous operations — before we sign it.
    WebAuth.readChallengeTx(
      challenge.transaction,
      info.signingKey,
      this.networkPassphrase,
      homeDomain,
      new URL(info.webAuthEndpoint).hostname,
    );

    const tx = TransactionBuilder.fromXDR(challenge.transaction, this.networkPassphrase);
    tx.sign(this.keypair);

    const { token } = await http<{ token: string }>(info.webAuthEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: tx.toXDR() }),
    });

    this.tokens.set(homeDomain, { token, expiresAt: jwtExpiry(token) });
    log.info(`Authenticated with ${homeDomain} (SEP-10)`);
    return token;
  }

  async startWithdrawal(anchor: AnchorConfig, amount: string): Promise<InteractiveWithdrawal> {
    const info = await this.discover(anchor.homeDomain);
    const token = await this.authenticate(anchor.homeDomain);
    return retryAsync(
      () =>
        http<{ type: string; url: string; id: string }>(`${info.transferServer}/transactions/withdraw/interactive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            asset_code: anchor.code,
            asset_issuer: anchor.issuer,
            amount,
            account: this.keypair.publicKey(),
            lang: 'en',
          }),
        }),
      { retries: 2, label: 'sep24 withdraw', logger: log, shouldRetry: retryable },
    );
  }

  async getTransaction(anchor: AnchorConfig, id: string): Promise<Sep24Transaction> {
    const info = await this.discover(anchor.homeDomain);
    const token = await this.authenticate(anchor.homeDomain);
    const res = await http<{ transaction: Sep24Transaction }>(
      `${info.transferServer}/transaction?id=${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return res.transaction;
  }
}

function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    /* fall through */
  }
  return Date.now() + 10 * 60_000;
}
