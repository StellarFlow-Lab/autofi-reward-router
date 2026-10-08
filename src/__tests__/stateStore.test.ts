import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../services/stateStore';
import { silenceLogs } from './helpers';

silenceLogs();

const base = { rewardTxHash: 't', developerPublicKey: 'G', source: 'drips' as const, receivedAmount: '1', receivedAsset: 'USDC', dryRun: false };

describe('StateStore', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofi-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('persists cursor and records across restarts', () => {
    const file = path.join(dir, 'state.json');
    const a = new StateStore(file);
    a.setCursor('999');
    a.upsert({ ...base, eventId: 'e1', status: 'swapped' });
    a.upsert({ ...base, eventId: 'e1', status: 'withdrawal_pending', withdrawal: { anchorTxId: 'w', homeDomain: 'd', interactiveUrl: 'u', status: 'incomplete', updatedAt: '' } });

    const b = new StateStore(file);
    expect(b.getCursor()).toBe('999');
    expect(b.get('e1')!.status).toBe('withdrawal_pending');
    expect(b.pendingWithdrawals()).toHaveLength(1);
    expect(b.list()).toHaveLength(1);
  });

  test('preserves createdAt on update and filters lists', () => {
    const s = StateStore.inMemory();
    const first = s.upsert({ ...base, eventId: 'e1', status: 'processing' });
    const second = s.upsert({ ...first, status: 'failed' });
    s.upsert({ ...base, eventId: 'e2', developerPublicKey: 'OTHER', status: 'skipped' });
    expect(second.createdAt).toBe(first.createdAt);
    expect(s.list({ status: 'failed' }).map((r) => r.eventId)).toEqual(['e1']);
    expect(s.list({ developer: 'OTHER' }).map((r) => r.eventId)).toEqual(['e2']);
  });

  test('backs up a corrupt state file instead of crashing', () => {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{not json');
    const s = new StateStore(file);
    expect(s.list()).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.includes('corrupt'))).toBe(true);
  });
});
