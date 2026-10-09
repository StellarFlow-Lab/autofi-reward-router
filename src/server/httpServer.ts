import * as http from 'http';
import type { AddressInfo } from 'net';
import { timingSafeEqual } from 'crypto';
import type { OffRampStatus, RewardRecord } from '../types';
import type { StateStore } from '../services/stateStore';
import type { MetricsCollector } from '../utils/metrics';
import { logger as rootLogger, errorMessage } from '../utils/logger';
import { parseBountyEvent, verifyGitHubSignature, type BountyNotice } from './githubWebhook';

const log = rootLogger.child('http');
const MAX_BODY = 1024 * 1024;

export interface ServerDeps {
  store: StateStore;
  metrics: MetricsCollector;
  info: Record<string, unknown>;
  /** Readiness probe merged into GET /health; `ok: false` returns HTTP 503. */
  health?: () => { ok: boolean } & Record<string, unknown>;
  githubWebhookSecret?: string;
  adminToken?: string;
  /** e.g. https://stellarflow-lab.github.io — enables CORS for the web app. */
  corsOrigin?: string;
  retryWithdrawal?: (eventId: string) => Promise<RewardRecord>;
  onBounty?: (notice: BountyNotice) => void;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Small dependency-free HTTP API:
 *   GET  /health                   503 if Horizon hasn't been reached recently
 *   GET  /metrics                  counters
 *   GET  /rewards?status=&limit=   processed rewards           (admin)
 *   POST /rewards/:id/withdraw     retry opening a withdrawal  (admin)
 *   POST /webhooks/github          signed GitHub bounty webhook
 */
export function createHttpServer(deps: ServerDeps): http.Server {
  const requireAdmin = (req: http.IncomingMessage) => {
    if (!deps.adminToken) return;
    const header = req.headers.authorization ?? '';
    if (!safeEqual(header, `Bearer ${deps.adminToken}`)) throw new HttpError(401, 'unauthorized');
  };

  const handle = async (req: http.IncomingMessage): Promise<[number, unknown]> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /health') {
      const h = deps.health?.() ?? { ok: true };
      const { ok, ...details } = h;
      return [ok ? 200 : 503, { status: ok ? 'ok' : 'degraded', ...deps.info, ...details }];
    }
    if (route === 'GET /metrics') return [200, deps.metrics.getMetrics()];

    if (route === 'GET /rewards') {
      requireAdmin(req);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500);
      const status = (url.searchParams.get('status') ?? undefined) as OffRampStatus | undefined;
      return [200, { rewards: deps.store.list({ status, limit }) }];
    }

    const retry = url.pathname.match(/^\/rewards\/([^/]+)\/withdraw$/);
    if (req.method === 'POST' && retry) {
      requireAdmin(req);
      if (!deps.retryWithdrawal) throw new HttpError(400, 'SEP-24 is disabled');
      return [200, await deps.retryWithdrawal(decodeURIComponent(retry[1]))];
    }

    if (route === 'POST /webhooks/github') {
      if (!deps.githubWebhookSecret) throw new HttpError(404, 'GitHub webhook not configured');
      const body = await readBody(req);
      if (!verifyGitHubSignature(body, req.headers['x-hub-signature-256'] as string | undefined, deps.githubWebhookSecret)) {
        throw new HttpError(401, 'invalid signature');
      }
      const event = req.headers['x-github-event'] as string | undefined;
      if (event === 'ping') return [200, { ok: true }];
      const notice = parseBountyEvent(event, JSON.parse(body.toString('utf-8')));
      if (notice) deps.onBounty?.(notice);
      return [202, { bounty: notice }];
    }

    throw new HttpError(404, 'not found');
  };

  return http.createServer((req, res) => {
    // Lets the web app (web/) read /rewards from another origin.
    if (deps.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', deps.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }
    handle(req)
      .then(([status, body]) => send(res, status, body))
      .catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (status >= 500) log.error(`${req.method} ${req.url} failed`, errorMessage(err));
        send(res, status, { error: status >= 500 ? 'internal error' : err.message });
      });
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

export function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EADDRINUSE' ? new Error(`HTTP_PORT ${port} is already in use`) : err),
    );
    server.listen(port, () => resolve((server.address() as AddressInfo).port));
  });
}
