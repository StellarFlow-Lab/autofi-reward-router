import * as fs from 'fs';
import * as path from 'path';
import type { RewardRecord } from '../types';
import { logger as rootLogger, errorMessage } from '../utils/logger';

const log = rootLogger.child('state');

interface PersistedState {
  version: 1;
  /** Horizon paging token of the last payment we handled. */
  cursor?: string;
  records: RewardRecord[];
}

const MAX_RECORDS = 5000;

/**
 * Durable state for the router: the stream cursor (so restarts don't miss or
 * replay payments) and one record per processed reward (idempotency + history).
 * Writes are atomic (temp file + rename) so a crash never corrupts the file.
 */
export class StateStore {
  private state: PersistedState = { version: 1, records: [] };
  private index = new Map<string, RewardRecord>();

  constructor(private readonly filePath: string | null) {
    this.load();
  }

  /** In-memory store, for tests. */
  static inMemory(): StateStore {
    return new StateStore(null);
  }

  private load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as PersistedState;
      if (parsed.version === 1 && Array.isArray(parsed.records)) {
        this.state = parsed;
        for (const r of parsed.records) this.index.set(r.eventId, r);
        log.info(`Loaded ${parsed.records.length} records (cursor ${parsed.cursor ?? 'none'})`);
      }
    } catch (err) {
      // Keep the unreadable file around rather than silently overwriting it.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.filePath, backup);
      log.error(`State file unreadable, moved to ${backup}`, errorMessage(err));
    }
  }

  private save() {
    if (!this.filePath) return;
    const dir = path.dirname(path.resolve(this.filePath));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  getCursor(): string | undefined {
    return this.state.cursor;
  }

  setCursor(cursor: string) {
    this.state.cursor = cursor;
    this.save();
  }

  has(eventId: string): boolean {
    return this.index.has(eventId);
  }

  get(eventId: string): RewardRecord | undefined {
    return this.index.get(eventId);
  }

  upsert(record: Omit<RewardRecord, 'createdAt' | 'updatedAt'> & Partial<Pick<RewardRecord, 'createdAt'>>): RewardRecord {
    const now = new Date().toISOString();
    const existing = this.index.get(record.eventId);
    const full: RewardRecord = { ...existing, ...record, createdAt: existing?.createdAt ?? record.createdAt ?? now, updatedAt: now };
    if (existing) {
      Object.assign(existing, full);
    } else {
      this.state.records.push(full);
      this.index.set(full.eventId, full);
      if (this.state.records.length > MAX_RECORDS) {
        const dropped = this.state.records.splice(0, this.state.records.length - MAX_RECORDS);
        for (const d of dropped) this.index.delete(d.eventId);
      }
    }
    this.save();
    return this.index.get(record.eventId)!;
  }

  list(filter: { developer?: string; status?: RewardRecord['status']; limit?: number } = {}): RewardRecord[] {
    let out = this.state.records;
    if (filter.developer) out = out.filter((r) => r.developerPublicKey === filter.developer);
    if (filter.status) out = out.filter((r) => r.status === filter.status);
    return out.slice(-(filter.limit ?? 100)).reverse().map((r) => ({ ...r }));
  }

  /** Records whose anchor withdrawal is still in flight (resumed on restart). */
  pendingWithdrawals(): RewardRecord[] {
    return this.state.records.filter((r) => r.status === 'withdrawal_pending' && r.withdrawal);
  }
}
