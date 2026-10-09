import './style.css';
import { ContractClient, TESTNET_ANCHORS, validatePrefs, type RoutePreferences } from './contract';
import { getHealth, getRewards, type RewardRecord } from './api';
import { connectWallet, signWithWallet } from './wallet';

// ---------- settings (per browser) ----------
interface Settings {
  contractId: string;
  rpcUrl: string;
  apiUrl: string;
  token: string;
}
const DEFAULTS: Settings = {
  contractId: import.meta.env.VITE_CONTRACT_ID ?? 'CB5XHR2K5NXSHWL5QAPP2QWBC2FROCVGIH5OYQE5HUJVHJSGHQSY346T',
  rpcUrl: import.meta.env.VITE_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:8080',
  token: '',
};
const STORE_KEY = 'autofi.settings';

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this visit only */
  }
}

// ---------- DOM helpers ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};
const link = (href: string, text: string) => el('a', { href, textContent: text, target: '_blank', rel: 'noopener noreferrer' });
/** "50.0000000" -> "50", "4.3426935" stays. */
const amt = (s?: string) => (s === undefined ? '…' : s.includes('.') ? s.replace(/\.?0+$/, '') : s);
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);
const explorer = (kind: 'tx' | 'account' | 'contract', id: string) => `https://stellar.expert/explorer/testnet/${kind}/${id}`;

function notify(kind: 'ok' | 'err', ...content: (Node | string)[]) {
  const n = $('notice');
  n.className = `notice ${kind}`;
  n.replaceChildren(...content);
  n.hidden = false;
}
function setBadge(id: string, kind: 'ok' | 'warn' | 'err' | 'muted', text: string) {
  const b = $(id);
  b.className = `badge ${kind}`;
  b.textContent = text;
}
async function busy<T>(btn: HTMLButtonElement, label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (err) {
    notify('err', (err as Error).message);
    return undefined;
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// ---------- state ----------
let settings = loadSettings();
let address: string | null = null;
let current: RoutePreferences | null = null;

const client = () => new ContractClient(settings.rpcUrl, settings.contractId);

// ---------- split rule ----------
function renderRule() {
  const form = $('rule-form');
  const box = $('rule-current');
  if (!address) {
    setBadge('rule-badge', 'muted', 'Not connected');
    box.hidden = form.hidden = true;
    return;
  }
  form.hidden = false;
  $('remove').hidden = !current;
  if (!current) {
    setBadge('rule-badge', 'warn', 'No rule set');
    box.hidden = true;
    return;
  }
  setBadge('rule-badge', 'ok', 'Active on-chain');
  box.hidden = false;
  $('bar-off').style.width = `${current.offRampPct}%`;
  $('cur-off').textContent = `${current.offRampPct}%`;
  $('cur-keep').textContent = `${current.keepCryptoPct}%`;
  $('cur-asset').textContent = current.anchorAssetCode;

  // Pre-fill the form with the stored rule.
  ($('pct') as HTMLInputElement).value = String(current.offRampPct);
  $('pct-label').textContent = `${current.offRampPct}%`;
  const known = TESTNET_ANCHORS.find((a) => a.code === current!.anchorAssetCode && (!a.issuer || a.issuer === current!.anchorIssuer));
  ($('anchor') as HTMLSelectElement).value = known?.code ?? 'NGNX';
  ($('issuer') as HTMLInputElement).value = current.anchorIssuer;
  syncIssuerRow();
}

function syncIssuerRow() {
  const code = ($('anchor') as HTMLSelectElement).value;
  $('issuer-row').hidden = !!TESTNET_ANCHORS.find((a) => a.code === code)?.issuer;
}

async function loadRule() {
  if (!address) return;
  try {
    current = await client().getPreferences(address);
  } catch (err) {
    current = null;
    notify('err', `Couldn't read your rule: ${(err as Error).message}`);
  }
  renderRule();
}

async function saveRule(e: Event) {
  e.preventDefault();
  if (!address) return;
  const pct = Number(($('pct') as HTMLInputElement).value);
  const code = ($('anchor') as HTMLSelectElement).value;
  const anchor = TESTNET_ANCHORS.find((a) => a.code === code);
  const prefs: RoutePreferences = {
    offRampPct: pct,
    keepCryptoPct: 100 - pct,
    anchorAssetCode: code,
    anchorIssuer: anchor?.issuer ?? ($('issuer') as HTMLInputElement).value.trim(),
  };
  const problem = validatePrefs(prefs);
  if (problem) return notify('err', problem);

  await busy($('save') as HTMLButtonElement, 'Waiting for signature…', async () => {
    const c = client();
    const signed = await signWithWallet(await c.buildSet(address!, prefs), address!);
    const hash = await c.submit(signed);
    current = prefs;
    renderRule();
    notify('ok', `Saved: ${pct}% to ${code}. `, link(explorer('tx', hash), 'View transaction'));
  });
}

async function removeRule() {
  if (!address || !confirm('Remove your rule? AutoFi will fall back to the server default (or skip your rewards).')) return;
  await busy($('remove') as HTMLButtonElement, 'Waiting for signature…', async () => {
    const c = client();
    const hash = await c.submit(await signWithWallet(await c.buildRemove(address!), address!));
    current = null;
    renderRule();
    notify('ok', 'Rule removed. ', link(explorer('tx', hash), 'View transaction'));
  });
}

// ---------- payouts ----------
const STATUS: Record<string, { kind: 'ok' | 'warn' | 'err' | 'muted'; text: string }> = {
  completed: { kind: 'ok', text: 'Paid out' },
  withdrawal_pending: { kind: 'warn', text: 'Cash-out in progress' },
  swapped: { kind: 'ok', text: 'Swapped' },
  processing: { kind: 'muted', text: 'Processing' },
  skipped: { kind: 'muted', text: 'Skipped' },
  failed: { kind: 'err', text: 'Failed' },
};

function rewardItem(r: RewardRecord): HTMLLIElement {
  const st = STATUS[r.status] ?? { kind: 'muted' as const, text: r.status };
  const head = el('div', { className: 'row' },
    el('span', { className: 'amount', textContent: `${amt(r.receivedAmount)} ${r.receivedAsset}` }),
    el('span', { className: `badge ${st.kind}`, textContent: st.text }),
  );
  const parts: (Node | string)[] = [`${r.source} · ${new Date(r.createdAt).toLocaleString()}`];
  if (r.offRampAmount && r.destAsset) {
    parts.push(` · ${amt(r.offRampAmount)} ${r.receivedAsset} → ${amt(r.destAmount)} ${r.destAsset}`);
  }
  const meta = el('div', { className: 'meta' }, ...parts);
  const links = el('div', { className: 'meta' }, link(explorer('tx', r.rewardTxHash), 'Reward tx'));
  if (r.swapTxHash) links.append(' · ', link(explorer('tx', r.swapTxHash), 'Swap tx'));
  if (r.withdrawal?.paymentTxHash) links.append(' · ', link(explorer('tx', r.withdrawal.paymentTxHash), 'Payout tx'));
  if (r.status === 'withdrawal_pending' && r.withdrawal?.interactiveUrl) {
    links.append(' · ', link(r.withdrawal.interactiveUrl, 'Finish cash-out →'));
  }
  const li = el('li', {}, head, meta, links);
  if (r.reason && r.status !== 'completed') li.append(el('div', { className: 'meta', textContent: r.reason }));
  return li;
}

async function loadPayouts() {
  const list = $('rewards');
  try {
    const h = await getHealth(settings.apiUrl);
    setBadge('server-badge', h.status === 'ok' ? 'ok' : 'warn', h.status === 'ok' ? `Server online${h.dryRun ? ' (dry run)' : ''}` : 'Server degraded');
  } catch {
    setBadge('server-badge', 'err', 'Server unreachable');
    list.replaceChildren(el('li', { className: 'empty', textContent: `Can't reach ${settings.apiUrl}. Start AutoFi (npm run dev) or update the server URL in Settings.` }));
    return;
  }
  try {
    const rewards = await getRewards(settings.apiUrl, settings.token || undefined);
    list.replaceChildren(...(rewards.length ? rewards.map(rewardItem) : [el('li', { className: 'empty', textContent: 'No rewards yet.' })]));
  } catch (err) {
    list.replaceChildren(el('li', { className: 'empty', textContent: (err as Error).message }));
  }
}

// ---------- wiring ----------
function initSettingsForm() {
  const f = { contract: $('s-contract'), rpc: $('s-rpc'), api: $('s-api'), token: $('s-token') } as Record<string, HTMLInputElement>;
  f.contract.value = settings.contractId;
  f.rpc.value = settings.rpcUrl;
  f.api.value = settings.apiUrl;
  f.token.value = settings.token;
  $('settings').addEventListener('submit', (e) => {
    e.preventDefault();
    settings = { contractId: f.contract.value.trim(), rpcUrl: f.rpc.value.trim(), apiUrl: f.api.value.trim(), token: f.token.value.trim() };
    saveSettings(settings);
    notify('ok', 'Settings saved.');
    void loadRule();
    void loadPayouts();
  });
}

function init() {
  const select = $('anchor') as HTMLSelectElement;
  for (const a of TESTNET_ANCHORS) select.append(el('option', { value: a.code, textContent: a.label }));
  select.addEventListener('change', syncIssuerRow);
  syncIssuerRow();

  const pct = $('pct') as HTMLInputElement;
  pct.addEventListener('input', () => ($('pct-label').textContent = `${pct.value}%`));

  $('rule-form').addEventListener('submit', saveRule);
  $('remove').addEventListener('click', removeRule);
  $('refresh').addEventListener('click', () => void loadPayouts());

  const connect = $('connect') as HTMLButtonElement;
  connect.addEventListener('click', () =>
    busy(connect, 'Connecting…', async () => {
      address = await connectWallet();
      connect.textContent = short(address);
      $('notice').hidden = true;
      await loadRule();
    }).then(() => address && (connect.textContent = short(address))),
  );

  initSettingsForm();
  renderRule();
  void loadPayouts();
}

init();
