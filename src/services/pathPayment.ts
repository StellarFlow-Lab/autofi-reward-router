import {
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  Asset,
  Networks,
} from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';
import { retryAsync } from '../utils/retry';
import { calculateSlippageProtection } from '../utils/slippage';
import { initiateSEP24Deposit } from './sep24Deposit';
import { ANCHORS } from '../config/anchors';
import type { AnchorConfig } from '../types';

const server = new Horizon.Server(
  process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org'
);

const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK === 'mainnet'
  ? Networks.PUBLIC
  : Networks.TESTNET;

interface OffRampParams {
  developerKeypair: Keypair;
  sendAmount: string;
  sendAsset: Asset;
  destAsset: Asset;
  destMin?: string;
  slippagePercent?: number;
}

interface OffRampResult {
  txHash: string;
  depositUrl?: {
    id: string;
    type: 'interactive';
    url: string;
  };
}

/**
 * Resolves an anchor config from a Stellar asset by matching issuer.
 * Returns the anchor config if the issuer matches a configured anchor.
 */
function resolveAnchorConfig(asset: Asset): AnchorConfig | null {
  for (const anchor of Object.values(ANCHORS)) {
    if (anchor.issuer === asset.issuer || anchor.code === asset.code) {
      return anchor;
    }
  }
  return null;
}

export async function executePathPayment({
  developerKeypair,
  sendAmount,
  sendAsset,
  destAsset,
  destMin,
  slippagePercent = 2,
}: OffRampParams): Promise<OffRampResult> {
  return retryAsync(async () => {
    logger.debug(`Executing path payment: ${sendAmount} ${sendAsset.code} to ${destAsset.code}`);

    // Calculate slippage-protected minimum if not provided
    let finalDestMin = destMin;
    if (!destMin) {
      finalDestMin = await calculateSlippageProtection(
        { code: sendAsset.code, issuer: sendAsset.issuer },
        { code: destAsset.code, issuer: destAsset.issuer },
        sendAmount,
        slippagePercent
      );
      logger.debug(`Calculated min destination amount: ${finalDestMin}`);
    }

    const account = await server.loadAccount(developerKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset,
          sendAmount,
          destination: developerKeypair.publicKey(),
          destAsset,
          destMin: finalDestMin || '0.0000001',
          path: [],
        })
      )
      .setTimeout(30)
      .build();

    tx.sign(developerKeypair);
    const result = await server.submitTransaction(tx);
    logger.info(`Path payment successful: ${result.hash}`);

    // Trigger SEP-24 interactive deposit to off-ramp to fiat
    const anchorConfig = resolveAnchorConfig(destAsset);
    let depositUrl: OffRampResult['depositUrl'] | undefined;

    if (anchorConfig) {
      try {
        const depositResponse = await initiateSEP24Deposit({
          anchorConfig,
          amount: sendAmount,
          userPublicKey: developerKeypair.publicKey(),
        });
        depositUrl = {
          id: depositResponse.id,
          type: depositResponse.type,
          url: depositResponse.url,
        };
        logger.info(`SEP-24 deposit initiated: ${depositResponse.url}`);
      } catch (err) {
        logger.warn(
          'SEP-24 deposit initiation failed (non-fatal)',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return { txHash: result.hash, depositUrl };
  }, 3, 2000);
}
