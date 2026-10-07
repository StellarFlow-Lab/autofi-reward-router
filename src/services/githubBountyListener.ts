import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '../utils/logger';
import type { RewardEvent } from '../types';

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

export interface GitHubBountyEvent {
  action: string;
  issue?: {
    number: number;
    title: string;
    user: { login: string };
    labels: Array<{ name: string }>;
  };
  pull_request?: {
    number: number;
    user: { login: string };
    merged: boolean;
  };
}

/**
 * Validates the GitHub webhook signature using HMAC-SHA256.
 *
 * Per GitHub docs: the header is "sha256=<hex-digest>".
 * We compute the HMAC of the raw request body and compare it
 * with a timing-safe comparison to prevent timing attacks.
 */
export function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!secret) {
    logger.warn('GITHUB_WEBHOOK_SECRET not set — skipping signature validation');
    return true;
  }
  if (!signatureHeader) return false;

  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) return false;

  const receivedHex = signatureHeader.slice(expectedPrefix.length);
  const expected = createHmac('sha256', secret).update(rawBody, 'utf-8').digest('hex');

  try {
    const receivedBuf = Buffer.from(receivedHex, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    return receivedBuf.length === expectedBuf.length && timingSafeEqual(receivedBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Parses an incoming GitHub webhook payload into a RewardEvent.
 *
 * Handles bounty-labeled issues being closed (reward triggered)
 * and merged PRs with bounty labels.
 */
export async function parseGitHubBountyEvent(
  payload: GitHubBountyEvent,
  developerAddress: string,
): Promise<RewardEvent | null> {
  try {
    if (payload.action === 'closed' && payload.issue) {
      const hasBountyLabel = payload.issue.labels.some((l) =>
        l.name.toLowerCase().includes('bounty'),
      );
      if (hasBountyLabel) {
        logger.info(`GitHub bounty detected: ${payload.issue.title}`);
        return {
          developerPublicKey: developerAddress,
          amount: '100.00',
          assetCode: 'USDC',
          assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          sourceId: 'github_bounty',
        };
      }
    }

    if (payload.action === 'closed' && payload.pull_request?.merged) {
      logger.info(`Merged bounty PR detected from ${payload.pull_request.user.login}`);
      return {
        developerPublicKey: developerAddress,
        amount: '100.00',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        sourceId: 'github_bounty',
      };
    }

    return null;
  } catch (err) {
    logger.error(
      'Failed to parse GitHub bounty event',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Collects the raw body of an incoming HTTP request as a UTF-8 string.
 */
function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Starts an HTTP server that listens for GitHub webhook events at POST /webhook/github.
 *
 * The server validates the X-Hub-Signature-256 header, parses the payload,
 * and emits RewardEvents to the provided onReward handler.
 */
export async function startGitHubBountyListener(
  webhookPort: number = 3000,
  onReward: (event: RewardEvent) => Promise<void>,
): Promise<void> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/webhook/github') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    try {
      const rawBody = await collectBody(req);
      const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;

      if (!verifyGitHubSignature(rawBody, signatureHeader || '', GITHUB_WEBHOOK_SECRET)) {
        logger.warn('Invalid GitHub webhook signature');
        res.writeHead(401);
        res.end('Invalid signature');
        return;
      }

      const payload: GitHubBountyEvent = JSON.parse(rawBody);
      const event = await parseGitHubBountyEvent(payload, 'default');

      if (event) {
        await onReward(event);
        logger.info('GitHub bounty event processed successfully');
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    } catch (err) {
      logger.error('Webhook handler error', err instanceof Error ? err.message : String(err));
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  });

  server.listen(webhookPort, () => {
    logger.info(`GitHub bounty listener running on port ${webhookPort}`);
  });
}
