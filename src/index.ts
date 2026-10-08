import { existsSync } from 'fs';
import { startApp } from './app';
import { ConfigError, loadConfig } from './config/env';
import { logger, errorMessage } from './utils/logger';

async function main() {
  // Load .env without extra dependencies (Node >= 20.12).
  if (existsSync('.env')) process.loadEnvFile('.env');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`${err.message}\n\nSee .env.example for every option.`);
      process.exit(1);
    }
    throw err;
  }

  const app = await startApp(config);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', errorMessage(reason)));
}

main().catch((err) => {
  logger.error('Fatal error', errorMessage(err));
  process.exit(1);
});
