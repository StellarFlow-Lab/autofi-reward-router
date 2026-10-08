import { createHmac } from 'crypto';
import type * as http from 'http';
import { createHttpServer, listen } from '../server/httpServer';
import { StateStore } from '../services/stateStore';
import { MetricsCollector } from '../utils/metrics';
import { silenceLogs } from './helpers';

silenceLogs();

let server: http.Server;
let base: string;
const onBounty = jest.fn();
const store = StateStore.inMemory();

beforeAll(async () => {
  store.upsert({ eventId: 'e1', rewardTxHash: 't', developerPublicKey: 'G', source: 'drips', receivedAmount: '1', receivedAsset: 'USDC', status: 'skipped', dryRun: false });
  server = createHttpServer({
    store, metrics: new MetricsCollector(), info: { network: 'testnet' },
    githubWebhookSecret: 'whsec', adminToken: 'admin', onBounty,
  });
  base = `http://127.0.0.1:${await listen(server, 0)}`;
});
afterAll(() => new Promise((r) => server.close(r)));

describe('HTTP API', () => {
  test('health and metrics are public', async () => {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health).toEqual({ status: 'ok', network: 'testnet' });
    expect((await fetch(`${base}/metrics`)).status).toBe(200);
  });

  test('rewards require the admin token', async () => {
    expect((await fetch(`${base}/rewards`)).status).toBe(401);
    const res = await fetch(`${base}/rewards`, { headers: { Authorization: 'Bearer admin' } });
    expect((await res.json()).rewards).toHaveLength(1);
  });

  test('github webhook checks the signature', async () => {
    const body = JSON.stringify({ action: 'closed', issue: { number: 1, title: 'x', labels: [{ name: 'bounty 5 USDC' }] } });
    const sig = `sha256=${createHmac('sha256', 'whsec').update(body).digest('hex')}`;
    const post = (s: string) => fetch(`${base}/webhooks/github`, { method: 'POST', body, headers: { 'x-github-event': 'issues', 'x-hub-signature-256': s } });

    expect((await post('sha256=bad')).status).toBe(401);
    const ok = await post(sig);
    expect(ok.status).toBe(202);
    expect(onBounty).toHaveBeenCalledWith(expect.objectContaining({ amount: '5', asset: 'USDC' }));
  });

  test('unknown routes 404 and retry without SEP-24 is a 400', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const res = await fetch(`${base}/rewards/e1/withdraw`, { method: 'POST', headers: { Authorization: 'Bearer admin' } });
    expect(res.status).toBe(400);
  });
});
