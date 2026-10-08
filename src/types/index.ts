export type FiatCurrency = 'NGN' | 'USD' | 'GBP';
export type RewardSource = 'drips' | 'github_bounty' | 'manual';

/** Off-ramp preferences, as stored in the reward_router Soroban contract. */
export interface RoutePreferences {
  offRampPct: number;      // 0-100
  keepCryptoPct: number;   // 0-100, offRampPct + keepCryptoPct === 100
  anchorAssetCode: string; // e.g. "NGNX" | "USDC" | "GBPT"
  anchorIssuer: string;    // G... address
}

/** A Stellar asset in plain-data form (native XLM has no issuer). */
export interface AssetRef {
  code: string;
  issuer?: string;
}

/** An inbound payment that looks like a developer reward. */
export interface RewardEvent {
  /** Horizon operation id — globally unique, used for idempotency. */
  id: string;
  txHash: string;
  developerPublicKey: string;
  from: string;
  amount: string;
  asset: AssetRef;
  source: RewardSource;
  receivedAt: string;
}

export interface AnchorConfig {
  code: string;
  issuer: string;
  homeDomain: string;
  currency: FiatCurrency;
}

export type OffRampStatus =
  | 'processing'
  | 'skipped'
  | 'swapped'
  | 'withdrawal_pending'
  | 'completed'
  | 'failed';

export interface WithdrawalInfo {
  anchorTxId: string;
  homeDomain: string;
  interactiveUrl: string;
  status: string;
  paymentTxHash?: string;
  updatedAt: string;
}

/** One processed reward and everything AutoFi did with it. */
export interface RewardRecord {
  eventId: string;
  rewardTxHash: string;
  developerPublicKey: string;
  source: RewardSource;
  receivedAmount: string;
  receivedAsset: string;
  offRampAmount?: string;
  destAsset?: string;
  destAmount?: string;
  swapTxHash?: string;
  withdrawal?: WithdrawalInfo;
  status: OffRampStatus;
  reason?: string;
  dryRun: boolean;
  createdAt: string;
  updatedAt: string;
}
