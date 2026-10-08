import type * as http from 'http';
import { loadConfig, type AppConfig } from './config/env';
import { createRewardProcessor, openWithdrawal } from './core/rewardProcessor';
import { startWithdrawalMonitor } from './core/withdrawalMonitor';
import { Sep24AnchorClient } from './services/anchorClient';
import { startPaymentListener } from './services/paymentListener';
import { RateLimiter } from './services/rateLimiter';
import { FallbackPreferencesProvider, SorobanPreferencesClient } from './services/sorobanClient';
import { StateStore } from './services/stateStore';
import { StellarWallet } from './services/stellarWallet';
import { createHttpServer, HttpError, listen } from './server/httpServer';
import { logger } from './utils/logger';
import { metricsCollector } from './utils/metrics';

export interface RunningApp {
  config: AppConfig;
  port: number;
  stop: () => Promise<void>;
}

/** Wire every component together from config and start the service. */
export async function startApp(config: AppConfig = loadConfig()): Promise<RunningApp> {
  logger.setLevel(config.logLevel);
  const log = logger.child('app');

  const store = new StateStore(config.stateFile);
  const wallet = new StellarWallet({
    horizonUrl: config.horizonUrl,
    networkPassphrase: config.networkPassphrase,
    keypair: config.keypair,
    slippageBps: config.slippageBps,
    maxFeeStroops: config.maxFeeStroops,
    dryRun: config.dryRun,
  });
  const contract = config.contractId
    ? new SorobanPreferencesClient(config.sorobanRpcUrl, config.contractId, config.networkPassphrase, config.publicKey)
    : null;
  const preferences = new FallbackPreferencesProvider(contract, config.defaultPreferences);
  const anchorClient = config.sep24Enabled ? new Sep24AnchorClient(config.keypair, config.networkPassphrase) : null;

  const processReward = createRewardProcessor({
    preferences,
    wallet,
    anchors: config.anchors,
    anchorClient,
    store,
    metrics: metricsCollector,
    rateLimiter: new RateLimiter(config.rateLimitCapacity, config.rateLimitRefillPerSec),
    dryRun: config.dryRun,
  });

  const server: http.Server = createHttpServer({
    store,
    metrics: metricsCollector,
    githubWebhookSecret: config.githubWebhookSecret,
    adminToken: config.adminToken,
    info: { network: config.network, account: config.publicKey, dryRun: config.dryRun, anchors: Object.keys(config.anchors) },
    onBounty: (b) =>
      log.info(`GitHub bounty closed: ${b.repo}#${b.number} "${b.title}" → ${b.developer ?? 'unknown'} (${b.amount ?? '?'} ${b.asset ?? ''}). Payout will be routed when it lands on-chain.`),
    retryWithdrawal: anchorClient
      ? async (eventId) => {
          const record = store.get(eventId);
          if (!record) throw new HttpError(404, 'reward not found');
          if (record.status !== 'swapped' || !record.destAmount) {
            throw new HttpError(409, `reward is ${record.status}, expected swapped`);
          }
          const anchor = config.anchors[record.destAsset ?? ''];
          if (!anchor) throw new HttpError(409, `anchor ${record.destAsset} not configured`);
          return openWithdrawal(record, anchor, { anchorClient, store, metrics: metricsCollector });
        }
      : undefined,
  });
  const port = await listen(server, config.httpPort);

  const listener = startPaymentListener({
    server: wallet.server,
    filter: {
      publicKey: config.publicKey,
      rewardAssets: config.rewardAssets,
      minRewardAmount: config.minRewardAmount,
      dripsSenders: config.dripsSenders,
      bountySenders: config.bountySenders,
      requireKnownSender: config.requireKnownSender,
      anchors: config.anchors,
    },
    getCursor: () => store.getCursor(),
    setCursor: (c) => store.setCursor(c),
    startCursor: config.startCursor,
    onReward: async (e) => {
      await processReward(e);
    },
  });

  const monitor = anchorClient
    ? startWithdrawalMonitor({
        anchorClient,
        wallet,
        store,
        metrics: metricsCollector,
        anchors: config.anchors,
        autoSend: config.sep24AutoSend,
        pollIntervalMs: config.sep24PollIntervalMs,
        timeoutMs: config.sep24TimeoutMs,
      })
    : null;

  log.info(
    `AutoFi running on ${config.network}${config.dryRun ? ' (DRY RUN — nothing will be submitted)' : ''} | account ${config.publicKey} | ` +
      `anchors ${Object.keys(config.anchors).join(', ')} | prefs ${config.contractId ? `contract ${config.contractId}` : 'defaults'} | http :${port}`,
  );

  return {
    config,
    port,
    stop: async () => {
      log.info('Shutting down…');
      await Promise.all([listener.stop(), monitor?.stop()]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      log.info(`Final metrics: ${JSON.stringify(metricsCollector.getMetrics())}`);
    },
  };
}
