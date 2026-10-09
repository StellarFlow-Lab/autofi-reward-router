import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import type { AssetRef } from '../types';
import { applySlippage, toStroops } from '../utils/amount';
import { logger as rootLogger, errorMessage } from '../utils/logger';
import { retryAsync, sleep } from '../utils/retry';

const log = rootLogger.child('wallet');

export function toSdkAsset(a: AssetRef): Asset {
  return a.issuer ? new Asset(a.code, a.issuer) : Asset.native();
}

export function sameAsset(a: AssetRef, b: AssetRef): boolean {
  return a.code === b.code && (a.issuer ?? '') === (b.issuer ?? '');
}

export interface SwapQuote {
  sendAmount: string;
  destAmount: string;  // best price Horizon found
  destMin: string;     // what we'll accept after slippage
  path: Asset[];
}

export interface SwapResult extends SwapQuote {
  txHash?: string;     // undefined for dry runs / no-op swaps
  received: string;    // actual amount credited (or quoted, for dry runs)
}

export interface PaymentRequest {
  to: string;
  asset: AssetRef;
  amount: string;
  memo?: string;
  memoType?: 'text' | 'id' | 'hash';
}

export interface Wallet {
  readonly publicKey: string;
  quote(send: AssetRef, sendAmount: string, dest: AssetRef): Promise<SwapQuote>;
  swap(send: AssetRef, sendAmount: string, dest: AssetRef): Promise<SwapResult>;
  pay(req: PaymentRequest): Promise<string | undefined>;
}

/** Horizon error with the transaction/operation result codes extracted. */
export class TxFailedError extends Error {
  name = 'TxFailedError';
  constructor(message: string, public readonly resultCodes?: unknown) {
    super(message);
  }
}

export class NoPathError extends Error {
  name = 'NoPathError';
}

interface WalletOptions {
  horizonUrl: string;
  networkPassphrase: string;
  keypair: Keypair;
  slippageBps: number;
  maxFeeStroops: number;
  dryRun: boolean;
}

/**
 * Everything AutoFi does on the Stellar classic network: quoting & executing
 * strict-send path payments (the swap), adding trustlines on demand, and
 * paying anchors.
 */
export class StellarWallet implements Wallet {
  readonly server: Horizon.Server;
  readonly publicKey: string;

  constructor(private readonly opts: WalletOptions) {
    this.server = new Horizon.Server(opts.horizonUrl, { allowHttp: opts.horizonUrl.startsWith('http://') });
    this.publicKey = opts.keypair.publicKey();
  }

  async quote(send: AssetRef, sendAmount: string, dest: AssetRef): Promise<SwapQuote> {
    if (sameAsset(send, dest)) {
      return { sendAmount, destAmount: sendAmount, destMin: sendAmount, path: [] };
    }

    const { records } = await retryAsync(
      () => this.server.strictSendPaths(toSdkAsset(send), sendAmount, [toSdkAsset(dest)]).call(),
      { retries: 2, label: 'strictSendPaths', logger: log },
    );
    if (!records.length) {
      throw new NoPathError(`No DEX path from ${send.code} to ${dest.code} for ${sendAmount}`);
    }

    const best = records.reduce((a, b) =>
      toStroops(b.destination_amount) > toStroops(a.destination_amount) ? b : a,
    );
    const path = best.path.map((p) =>
      p.asset_type === 'native' ? Asset.native() : new Asset(p.asset_code, p.asset_issuer),
    );
    return {
      sendAmount,
      destAmount: best.destination_amount,
      destMin: applySlippage(best.destination_amount, this.opts.slippageBps),
      path,
    };
  }

  async swap(send: AssetRef, sendAmount: string, dest: AssetRef): Promise<SwapResult> {
    const q = await this.quote(send, sendAmount, dest);
    if (sameAsset(send, dest)) {
      log.info(`Reward already in ${dest.code}, no swap needed`);
      return { ...q, received: sendAmount };
    }

    log.info(`Swap ${sendAmount} ${send.code} → ≥${q.destMin} ${dest.code} (quote ${q.destAmount}, ${q.path.length} hop(s))`);
    if (this.opts.dryRun) {
      log.info('[dry-run] swap not submitted');
      return { ...q, received: q.destAmount };
    }

    const account = await this.server.loadAccount(this.publicKey);
    const ops: xdr.Operation[] = [];
    if (!this.hasTrustline(account, dest)) {
      log.info(`Adding trustline for ${dest.code}`);
      ops.push(Operation.changeTrust({ asset: toSdkAsset(dest) }));
    }
    ops.push(
      Operation.pathPaymentStrictSend({
        sendAsset: toSdkAsset(send),
        sendAmount,
        destination: this.publicKey,
        destAsset: toSdkAsset(dest),
        destMin: q.destMin,
        path: q.path,
      }),
    );

    const hash = await this.submit(account, ops);
    const received = await this.receivedAmount(hash).catch(() => q.destMin);
    return { ...q, txHash: hash, received };
  }

  async pay(req: PaymentRequest): Promise<string | undefined> {
    log.info(`Pay ${req.amount} ${req.asset.code} → ${req.to}${req.memo ? ` (memo ${req.memoType ?? 'text'}:${req.memo})` : ''}`);
    if (this.opts.dryRun) {
      log.info('[dry-run] payment not submitted');
      return undefined;
    }
    const account = await this.server.loadAccount(this.publicKey);
    const op = Operation.payment({ destination: req.to, asset: toSdkAsset(req.asset), amount: req.amount });
    return this.submit(account, [op], buildMemo(req.memo, req.memoType));
  }

  private hasTrustline(account: Horizon.AccountResponse, asset: AssetRef): boolean {
    if (!asset.issuer) return true;
    return account.balances.some(
      (b) => 'asset_code' in b && b.asset_code === asset.code && b.asset_issuer === asset.issuer,
    );
  }

  private async fee(): Promise<string> {
    const base = await this.server.fetchBaseFee().catch(() => 100);
    return String(Math.min(this.opts.maxFeeStroops, Math.max(100, base * 2)));
  }

  /**
   * Build, sign and submit once; on timeouts re-submit the *same* signed
   * envelope. Re-building would use a new sequence number and could execute
   * the swap twice — resubmitting the identical tx is idempotent.
   */
  private async submit(account: Horizon.AccountResponse, ops: xdr.Operation[], memo?: Memo): Promise<string> {
    const builder = new TransactionBuilder(account, {
      fee: await this.fee(),
      networkPassphrase: this.opts.networkPassphrase,
    }).setTimeout(60);
    ops.forEach((op) => builder.addOperation(op));
    if (memo) builder.addMemo(memo);
    const tx = builder.build();
    tx.sign(this.opts.keypair);
    const hash = Buffer.from(tx.hash()).toString('hex');

    return retryAsync(
      async () => {
        try {
          const res = await this.server.submitTransaction(tx as Transaction);
          log.info(`Transaction confirmed ${res.hash}`);
          return res.hash;
        } catch (err) {
          const resp = (err as { response?: { status?: number; data?: { extras?: { result_codes?: unknown } } } }).response;
          const codes = resp?.data?.extras?.result_codes;
          if (codes) throw new TxFailedError(`Transaction failed: ${JSON.stringify(codes)}`, codes);
          // Timeout/network: maybe it landed anyway.
          if (await this.txLanded(hash)) return hash;
          throw err;
        }
      },
      {
        retries: 4,
        initialDelayMs: 3000,
        label: `submit ${hash.slice(0, 8)}`,
        logger: log,
        shouldRetry: (e) => !(e instanceof TxFailedError),
      },
    );
  }

  private async txLanded(hash: string): Promise<boolean> {
    try {
      const tx = await this.server.transactions().transaction(hash).call();
      return tx.successful;
    } catch {
      return false;
    }
  }

  /** Read the actual amount delivered by the path payment in a tx. */
  private async receivedAmount(hash: string): Promise<string> {
    for (let i = 0; i < 3; i++) {
      try {
        const ops = await this.server.operations().forTransaction(hash).call();
        const pp = ops.records.find((o) => o.type === 'path_payment_strict_send') as
          | Horizon.ServerApi.PathPaymentStrictSendOperationRecord
          | undefined;
        if (pp) return pp.amount;
      } catch (err) {
        log.debug('Could not read swap result yet', errorMessage(err));
      }
      await sleep(1000);
    }
    throw new Error('swap result not found');
  }
}

function buildMemo(memo?: string, type: PaymentRequest['memoType'] = 'text'): Memo | undefined {
  if (!memo) return undefined;
  if (type === 'id') return Memo.id(memo);
  if (type === 'hash') return Memo.hash(Buffer.from(memo, 'base64').toString('hex'));
  return Memo.text(memo);
}
