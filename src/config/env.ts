import { Keypair, Networks } from '@stellar/stellar-sdk';
import type { AnchorConfig, AssetRef, RoutePreferences } from '../types';
import { LogLevel } from '../utils/logger';
import { isPositiveAmount } from '../utils/amount';
import {
  validateContractId,
  validatePercentage,
  validateStellarPublicKey,
  validateStellarSecretKey,
} from '../utils/validation';
import { buildAnchors, parseAssetList } from './anchors';

export type StellarNetwork = 'testnet' | 'mainnet';

export interface AppConfig {
  network: StellarNetwork;
  networkPassphrase: string;
  horizonUrl: string;
  sorobanRpcUrl: string;

  keypair: Keypair;
  publicKey: string;

  /** reward_router contract. When unset, `defaultPreferences` is used for everyone. */
  contractId?: string;
  /** Fallback when the contract has no preferences for the developer. */
  defaultPreferences?: RoutePreferences;

  anchors: Record<string, AnchorConfig>;
  /** Only inbound payments in these assets are treated as rewards. */
  rewardAssets: AssetRef[];
  minRewardAmount: string;
  dripsSenders: string[];
  bountySenders: string[];
  /** If true, only payments from known Drips/bounty senders are processed. */
  requireKnownSender: boolean;
  startCursor: string;

  slippageBps: number;
  maxFeeStroops: number;

  sep24Enabled: boolean;
  sep24AutoSend: boolean;
  sep24PollIntervalMs: number;
  sep24TimeoutMs: number;

  httpPort: number;
  githubWebhookSecret?: string;
  adminToken?: string;
  corsOrigin?: string;

  rateLimitCapacity: number;
  rateLimitRefillPerSec: number;

  stateFile: string;
  dryRun: boolean;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const DEFAULT_URLS: Record<StellarNetwork, { horizon: string; rpc: string }> = {
  testnet: { horizon: 'https://horizon-testnet.stellar.org', rpc: 'https://soroban-testnet.stellar.org' },
  // SDF runs no public mainnet RPC; pick a provider from developers.stellar.org/docs/data/apis/rpc/providers
  mainnet: { horizon: 'https://horizon.stellar.org', rpc: '' },
};

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v.trim());

const list = (v: string | undefined) =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Read and validate configuration from an env object. Pure: pass any object
 * (handy in tests). Collects every problem and throws a single ConfigError.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const problems: string[] = [];

  const num = (name: string, fallback: number, check: (n: number) => boolean, rule: string) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !check(n)) {
      problems.push(`${name} must be ${rule} (got "${raw}")`);
      return fallback;
    }
    return n;
  };

  // --- Network ---
  const networkRaw = (env.STELLAR_NETWORK ?? 'testnet').trim().toLowerCase();
  if (networkRaw !== 'testnet' && networkRaw !== 'mainnet') {
    problems.push('STELLAR_NETWORK must be "testnet" or "mainnet"');
  }
  const network: StellarNetwork = networkRaw === 'mainnet' ? 'mainnet' : 'testnet';

  // --- Keys ---
  let keypair = Keypair.random();
  const secret = env.DEV_PRIVATE_KEY?.trim();
  if (!secret || !validateStellarSecretKey(secret)) {
    problems.push('DEV_PRIVATE_KEY is required and must be a valid Stellar secret key (S...)');
  } else {
    keypair = Keypair.fromSecret(secret);
    const pub = env.DEV_PUBLIC_KEY?.trim();
    if (pub && pub !== keypair.publicKey()) {
      problems.push('DEV_PUBLIC_KEY does not match DEV_PRIVATE_KEY (you can leave DEV_PUBLIC_KEY empty)');
    }
  }

  // --- Contract ---
  const contractId = env.REWARD_ROUTER_CONTRACT_ID?.trim() || undefined;
  if (contractId && !validateContractId(contractId)) {
    problems.push('REWARD_ROUTER_CONTRACT_ID must be a valid contract id (C...)');
  }

  if (contractId && network === 'mainnet' && !env.SOROBAN_RPC_URL?.trim()) {
    problems.push('SOROBAN_RPC_URL is required on mainnet when REWARD_ROUTER_CONTRACT_ID is set');
  }

  // --- Anchors ---
  const anchors = buildAnchors(network, env);
  for (const a of Object.values(anchors)) {
    if (!validateStellarPublicKey(a.issuer)) problems.push(`${a.code}_ISSUER is not a valid Stellar public key`);
  }

  // --- Default preferences ---
  let defaultPreferences: RoutePreferences | undefined;
  const defaultAnchor = env.DEFAULT_ANCHOR?.trim().toUpperCase();
  if (defaultAnchor) {
    const anchor = anchors[defaultAnchor];
    const pct = num('DEFAULT_OFF_RAMP_PCT', 100, validatePercentage, 'an integer 0-100');
    if (!anchor) {
      problems.push(`DEFAULT_ANCHOR "${defaultAnchor}" is not an enabled anchor (enabled: ${Object.keys(anchors).join(', ') || 'none'})`);
    } else {
      defaultPreferences = {
        offRampPct: pct,
        keepCryptoPct: 100 - pct,
        anchorAssetCode: anchor.code,
        anchorIssuer: anchor.issuer,
      };
    }
  }
  if (!contractId && !defaultPreferences) {
    problems.push('Set REWARD_ROUTER_CONTRACT_ID, or DEFAULT_ANCHOR (+ DEFAULT_OFF_RAMP_PCT), so AutoFi knows how to route rewards');
  }

  // --- Reward detection ---
  let rewardAssets: AssetRef[] = [];
  try {
    rewardAssets = parseAssetList(env.REWARD_ASSETS ?? 'USDC,XLM', network);
    if (rewardAssets.length === 0) problems.push('REWARD_ASSETS must list at least one asset');
  } catch (err) {
    problems.push(`REWARD_ASSETS: ${(err as Error).message}`);
  }

  const minRewardAmount = env.MIN_REWARD_AMOUNT?.trim() || '1';
  if (!isPositiveAmount(minRewardAmount)) problems.push('MIN_REWARD_AMOUNT must be a positive amount');

  const dripsSenders = list(env.DRIPS_SENDERS);
  const bountySenders = list(env.BOUNTY_SENDERS);
  for (const s of [...dripsSenders, ...bountySenders]) {
    if (!validateStellarPublicKey(s)) problems.push(`Sender "${s}" is not a valid Stellar public key`);
  }
  const requireKnownSender = bool(env.REQUIRE_KNOWN_SENDER, false);
  if (requireKnownSender && dripsSenders.length + bountySenders.length === 0) {
    problems.push('REQUIRE_KNOWN_SENDER=true but DRIPS_SENDERS and BOUNTY_SENDERS are both empty');
  }

  // --- Swap ---
  // SLIPPAGE_TOLERANCE_PCT (percent, e.g. 1 = 1%) is still accepted for existing deployments.
  const legacyPct = num('SLIPPAGE_TOLERANCE_PCT', 2, (n) => n >= 0 && n <= 50, 'a percentage 0-50');
  const slippageBps = num('SLIPPAGE_BPS', Math.round(legacyPct * 100), (n) => Number.isInteger(n) && n >= 0 && n <= 5000, 'an integer 0-5000');
  const maxFeeStroops = num('MAX_FEE_STROOPS', 100_000, (n) => Number.isInteger(n) && n >= 100, 'an integer >= 100');

  // --- SEP-24 ---
  const sep24PollIntervalMs = num('SEP24_POLL_INTERVAL_MS', 10_000, (n) => n >= 1000, '>= 1000');
  const sep24TimeoutMs = num('SEP24_TIMEOUT_MS', 24 * 60 * 60 * 1000, (n) => n >= 60_000, '>= 60000');

  // --- HTTP ---
  const httpPort = num('HTTP_PORT', 8080, (n) => Number.isInteger(n) && n >= 0 && n < 65536, 'a port number');

  // --- Rate limit ---
  const rateLimitCapacity = num('LISTENER_RATE_LIMIT_CAPACITY', 5, (n) => n >= 1, '>= 1');
  const rateLimitRefillPerSec = num('LISTENER_RATE_LIMIT_REFILL', 0.5, (n) => n > 0, '> 0');

  const logLevelName = (env.LOG_LEVEL ?? (bool(env.DEBUG, false) ? 'debug' : 'info')).toUpperCase();
  const logLevel = (LogLevel as unknown as Record<string, LogLevel>)[logLevelName] ?? LogLevel.INFO;

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    network,
    networkPassphrase: network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
    horizonUrl: env.HORIZON_URL?.trim() || DEFAULT_URLS[network].horizon,
    sorobanRpcUrl: env.SOROBAN_RPC_URL?.trim() || DEFAULT_URLS[network].rpc,
    keypair,
    publicKey: keypair.publicKey(),
    contractId,
    defaultPreferences,
    anchors,
    rewardAssets,
    minRewardAmount,
    dripsSenders,
    bountySenders,
    requireKnownSender,
    startCursor: env.START_CURSOR?.trim() || 'now',
    slippageBps,
    maxFeeStroops,
    sep24Enabled: bool(env.SEP24_ENABLED, true),
    sep24AutoSend: bool(env.SEP24_AUTO_SEND, true),
    sep24PollIntervalMs,
    sep24TimeoutMs,
    httpPort,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET?.trim() || undefined,
    adminToken: env.ADMIN_TOKEN?.trim() || undefined,
    corsOrigin: env.CORS_ORIGIN?.trim() || undefined,
    rateLimitCapacity,
    rateLimitRefillPerSec,
    stateFile: env.STATE_FILE?.trim() || '.autofi-state.json',
    dryRun: bool(env.DRY_RUN, false),
    logLevel,
  };
}
