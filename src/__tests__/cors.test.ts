import type * as http from 'http';
import { createHttpServer, listen } from '../server/httpServer';
import { StateStore } from '../services/stateStore';
import { MetricsCollector } from '../utils/metrics';
import { silenceLogs } from './helpers';

silenceLogs();

async function start(corsOrigin?: string): Promise<[http.Server, string]> {
  const server = createHttpServer({
    store: StateStore.inMemory(), metrics: new MetricsCollector(), info: {}, corsOrigin,
  });
  return [server, `http://127.0.0.1:${await listen(server, 0)}`];
}
const stop = (s: http.Server) => new Promise((r) => s.close(r));

describe('CORS', () => {
  test('answers preflight and tags responses when CORS_ORIGIN is set', async () => {
    const [server, base] = await start('https://app.example');
    try {
      const pre = await fetch(`${base}/rewards`, { method: 'OPTIONS' });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example');
      expect(pre.headers.get('access-control-allow-headers')).toContain('Authorization');

      const res = await fetch(`${base}/health`);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    } finally {
      await stop(server);
    }
  });

  test('sends no CORS headers when CORS_ORIGIN is unset', async () => {
    const [server, base] = await start();
    try {
      const res = await fetch(`${base}/health`);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect((await fetch(`${base}/health`, { method: 'OPTIONS' })).status).toBe(404);
    } finally {
      await stop(server);
    }
  });
});
