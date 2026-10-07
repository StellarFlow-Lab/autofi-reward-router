import { logger } from '../utils/logger';
import type { RewardEvent } from '../types';

type RewardHandler = (event: RewardEvent) => Promise<void>;

const DRIPS_SUBGRAPH_URL =
  process.env.DRIPS_SUBGRAPH_URL ||
  'https://api.thegraph.com/subgraphs/name/drips-network/drips';

interface SubgraphSplit {
  id: string;
  sender: string;
  receiver: string;
  amount: string;
  blockTimestamp: string;
  blockNumber: string;
}

interface SubgraphResponse {
  data?: {
    splits?: SubgraphSplit[];
  };
  errors?: Array<{ message: string }>;
}

/**
 * Queries the Drips subgraph for new Split events targeting the given address
 * since the last seen block.
 *
 * @param recipientAddress - Stellar public key to filter payouts for
 * @param lastBlock - Only fetch events after this block number
 */
async function fetchDripsSplits(
  recipientAddress: string,
  lastBlock: number,
): Promise<SubgraphSplit[]> {
  const query = `
    query($receiver: String!, $lastBlock: BigInt!) {
      splits(
        first: 100,
        where: { receiver: $receiver, blockNumber_gt: $lastBlock },
        orderBy: blockNumber,
        orderDirection: asc
      ) {
        id
        sender
        receiver
        amount
        blockTimestamp
        blockNumber
      }
    }
  `;

  const variables = {
    receiver: recipientAddress.toLowerCase(),
    lastBlock: String(lastBlock),
  };

  try {
    const response = await fetch(DRIPS_SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`Subgraph returned ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as SubgraphResponse;

    if (result.errors) {
      throw new Error(`Subgraph query error: ${result.errors[0].message}`);
    }

    return result.data?.splits ?? [];
  } catch (err) {
    logger.error(
      'Failed to fetch Drips subgraph splits',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

function mapSplitToRewardEvent(split: SubgraphSplit, recipientAddress: string): RewardEvent {
  return {
    developerPublicKey: recipientAddress,
    amount: split.amount,
    assetCode: 'USDC',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    sourceId: 'drips',
  };
}

/**
 * Polls the Drips subgraph for new Split events targeting the configured address.
 * Emits RewardEvents to the provided handler.
 *
 * Uses last-seen block tracking to avoid re-processing events.
 */
export async function startDripListener(
  recipientAddress: string,
  onReward: RewardHandler,
  intervalMs = 30_000,
): Promise<void> {
  logger.info(`[DripListener] Watching for Drips payouts to ${recipientAddress}`);

  let lastBlock = 0;

  // Fetch initial last block from subgraph to avoid processing historical events
  try {
    const recentSplits = await fetchDripsSplits(recipientAddress, 0);
    if (recentSplits.length > 0) {
      // Start from the last known block so we don't re-process old events
      const maxBlock = Math.max(...recentSplits.map((s) => Number(s.blockNumber)));
      lastBlock = maxBlock;
      logger.info(`[DripListener] Starting from block ${lastBlock} — ${recentSplits.length} historical events skipped`);
    }
  } catch {
    logger.warn('[DripListener] Could not fetch initial block, starting from 0');
  }

  const poll = async () => {
    try {
      const splits = await fetchDripsSplits(recipientAddress, lastBlock);

      for (const split of splits) {
        const event = mapSplitToRewardEvent(split, recipientAddress);
        logger.info(
          `[DripListener] New Drips split detected: ${split.amount} USDC from ${split.sender}`,
        );
        await onReward(event);
      }

      if (splits.length > 0) {
        // Update cursor to avoid re-processing
        const newMaxBlock = Math.max(...splits.map((s) => Number(s.blockNumber)));
        lastBlock = Math.max(lastBlock, newMaxBlock);
      }
    } catch (err) {
      logger.error(
        '[DripListener] Error in polling loop',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  // Initial poll immediately, then on interval
  await poll();
  setInterval(poll, intervalMs);
}
