/** Client for the AutoFi service's HTTP API (GET /health, GET /rewards). */

export interface Withdrawal {
  anchorTxId: string;
  homeDomain: string;
  interactiveUrl: string;
  status: string;
  paymentTxHash?: string;
}

export interface RewardRecord {
  eventId: string;
  rewardTxHash: string;
  source: string;
  receivedAmount: string;
  receivedAsset: string;
  offRampAmount?: string;
  destAsset?: string;
  destAmount?: string;
  swapTxHash?: string;
  withdrawal?: Withdrawal;
  status: string;
  reason?: string;
  createdAt: string;
}

export interface Health {
  status: string;
  network?: string;
  account?: string;
  dryRun?: boolean;
  anchors?: string[];
}

async function get<T>(url: string, token?: string): Promise<T> {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) throw new Error('The server needs an admin token (Settings).');
  // /health returns 503 with a JSON body when degraded — still useful.
  if (!res.ok && res.status !== 503) throw new Error(`Server answered HTTP ${res.status}.`);
  return (await res.json()) as T;
}

export const getHealth = (apiUrl: string) => get<Health>(`${trim(apiUrl)}/health`);

export const getRewards = (apiUrl: string, token?: string) =>
  get<{ rewards: RewardRecord[] }>(`${trim(apiUrl)}/rewards?limit=50`, token).then((r) => r.rewards);

const trim = (u: string) => u.replace(/\/+$/, '');
