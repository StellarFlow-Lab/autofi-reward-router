/**
 * Testnet kit: set up a wallet you can try AutoFi with, then send it rewards.
 *
 *   npm run testnet:setup            create + fund accounts, seed a DEX market, write .env
 *   npm run testnet:reward -- 25     pay the app 25 XLM from the "Drips" payer account
 *   npm run testnet:balances         show the app wallet's balances
 *   npm run testnet:anchor -- 500    get test SRT from testanchor.stellar.org and open an SRT/XLM market
 *   npm run testnet:prefs -- 60 SRT  store a 60% off-ramp rule (to SRT or NGNX) in the reward_router contract
 *
 * Testnet only. Nothing here can touch mainnet funds.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import {
  Address, Asset, BASE_FEE, Contract, Horizon, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal, rpc, xdr,
} from '@stellar/stellar-sdk';
import { TESTNET_SRT_ANCHOR } from '../src/config/anchors';
import { Sep24AnchorClient } from '../src/services/anchorClient';

const HORIZON = 'https://horizon-testnet.stellar.org';
const SOROBAN_RPC = 'https://soroban-testnet.stellar.org';
const FRIENDBOT = 'https://friendbot.stellar.org';
const ENV_FILE = '.env';
const server = new Horizon.Server(HORIZON);

// ---- .env helpers: update managed keys, keep everything else as-is ----
function readEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeEnv(values: Record<string, string>) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf-8').split('\n') : [];
  const pending = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const key = line.match(/^\s*#?\s*([A-Z0-9_]+)\s*=/)?.[1];
    if (key && pending.has(key)) {
      const v = pending.get(key)!;
      pending.delete(key);
      return `${key}=${v}`;
    }
    return line;
  });
  if (pending.size) {
    if (updated.length && updated[updated.length - 1] !== '') updated.push('');
    updated.push('# --- added by npm run testnet:setup ---');
    for (const [k, v] of pending) updated.push(`${k}=${v}`);
  }
  writeFileSync(ENV_FILE, updated.join('\n').replace(/\n*$/, '\n'));
}

// ---- Stellar helpers ----
async function exists(pub: string): Promise<boolean> {
  try {
    await server.loadAccount(pub);
    return true;
  } catch (err) {
    if ((err as { response?: { status?: number } }).response?.status === 404) return false;
    throw err;
  }
}

async function fund(label: string, pub: string) {
  if (await exists(pub)) return console.log(`  ✓ ${label} already funded`);
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`Friendbot failed for ${label}: HTTP ${res.status} ${await res.text()}`);
  console.log(`  ✓ ${label} funded with 10,000 test XLM`);
}

async function submit(signer: Keypair, ops: xdr.Operation[]): Promise<string> {
  const account = await server.loadAccount(signer.publicKey());
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }).setTimeout(60);
  ops.forEach((op) => builder.addOperation(op));
  const tx = builder.build();
  tx.sign(signer);
  try {
    return (await server.submitTransaction(tx)).hash;
  } catch (err) {
    const codes = (err as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response?.data?.extras?.result_codes;
    throw new Error(`Transaction failed${codes ? `: ${JSON.stringify(codes)}` : ''}`);
  }
}

const keypairFrom = (secret: string | undefined) => (secret ? Keypair.fromSecret(secret) : Keypair.random());

// ---- commands ----
async function setup() {
  if (!existsSync(ENV_FILE) && existsSync('.env.example')) copyFileSync('.env.example', ENV_FILE);
  const env = readEnv();
  if (env.STELLAR_NETWORK && env.STELLAR_NETWORK !== 'testnet') {
    throw new Error(`.env has STELLAR_NETWORK=${env.STELLAR_NETWORK}; this kit only works on testnet. Move that .env aside first.`);
  }

  const wallet = keypairFrom(env.DEV_PRIVATE_KEY || undefined);
  const payer = keypairFrom(env.TESTNET_PAYER_SECRET);
  const issuer = keypairFrom(env.TESTNET_NGNX_ISSUER_SECRET);

  console.log('1/3 Funding testnet accounts');
  await fund('app wallet', wallet.publicKey());
  await fund('reward payer', payer.publicKey());
  await fund('test NGNX issuer', issuer.publicKey());

  console.log('2/3 Making sure the DEX can swap XLM -> NGNX');
  const ngnx = new Asset('NGNX', issuer.publicKey());
  const offers = await server.offers().forAccount(issuer.publicKey()).call();
  if (offers.records.length) {
    console.log('  ✓ NGNX market already open');
  } else {
    // The issuer sells its own NGNX for XLM: 1 XLM buys 100 NGNX.
    await submit(issuer, [
      Operation.manageSellOffer({ selling: ngnx, buying: Asset.native(), amount: '1000000', price: '0.01' }),
    ]);
    console.log('  ✓ Opened NGNX/XLM market (1 XLM = 100 NGNX)');
  }

  console.log(`3/3 Writing ${ENV_FILE}`);
  writeEnv({
    STELLAR_NETWORK: 'testnet',
    DEV_PRIVATE_KEY: wallet.secret(),
    NGNX_ISSUER: issuer.publicKey(),
    DEFAULT_ANCHOR: 'NGNX',
    DEFAULT_OFF_RAMP_PCT: env.DEFAULT_OFF_RAMP_PCT || '70',
    REWARD_ASSETS: 'XLM',
    MIN_REWARD_AMOUNT: '1',
    DRIPS_SENDERS: payer.publicKey(),
    // The test NGNX has no real anchor behind it, so stop after the swap.
    SEP24_ENABLED: 'false',
    DRY_RUN: 'false',
    START_CURSOR: 'now',
    TESTNET_PAYER_SECRET: payer.secret(),
    TESTNET_NGNX_ISSUER_SECRET: issuer.secret(),
  });

  console.log(`
Done. Your test wallet: ${wallet.publicKey()}
  https://stellar.expert/explorer/testnet/account/${wallet.publicKey()}

Next:
  1. npm run dev                    (start AutoFi; leave it running)
  2. npm run testnet:reward -- 25   (in another terminal: send a 25 XLM "Drips" payout)
  3. Watch the logs: AutoFi swaps 70% into NGNX and keeps 30% as XLM.
     History: curl localhost:8080/rewards   Balances: npm run testnet:balances`);
}

async function reward(amountArg?: string) {
  const env = readEnv();
  if (!env.TESTNET_PAYER_SECRET || !env.DEV_PRIVATE_KEY) throw new Error('Run `npm run testnet:setup` first.');
  const amount = amountArg ?? '25';
  if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) throw new Error(`Invalid amount "${amount}"`);

  const payer = Keypair.fromSecret(env.TESTNET_PAYER_SECRET);
  const to = Keypair.fromSecret(env.DEV_PRIVATE_KEY).publicKey();
  const hash = await submit(payer, [Operation.payment({ destination: to, asset: Asset.native(), amount })]);
  console.log(`Sent ${amount} XLM reward to ${to}\n  https://stellar.expert/explorer/testnet/tx/${hash}\nAutoFi should pick it up within a few seconds.`);
}

async function balances() {
  const env = readEnv();
  if (!env.DEV_PRIVATE_KEY) throw new Error('Run `npm run testnet:setup` first.');
  const pub = Keypair.fromSecret(env.DEV_PRIVATE_KEY).publicKey();
  const account = await server.loadAccount(pub);
  console.log(`Wallet ${pub}`);
  for (const b of account.balances) {
    const code = b.asset_type === 'native' ? 'XLM' : 'asset_code' in b ? b.asset_code : b.asset_type;
    console.log(`  ${code.padEnd(6)} ${b.balance}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Get test SRT for the payer via a SEP-24 deposit at Stellar's reference
 * anchor, then offer it for XLM so AutoFi has a DEX path XLM -> SRT.
 */
async function anchor(amountArg?: string) {
  const env = readEnv();
  if (!env.TESTNET_PAYER_SECRET) throw new Error('Run `npm run testnet:setup` first.');
  const amount = amountArg ?? '500';
  const payer = Keypair.fromSecret(env.TESTNET_PAYER_SECRET);
  const srt = new Asset(TESTNET_SRT_ANCHOR.code, TESTNET_SRT_ANCHOR.issuer);

  const srtBalance = async () => {
    const acct = await server.loadAccount(payer.publicKey());
    const b = acct.balances.find((x) => 'asset_code' in x && x.asset_code === srt.code && x.asset_issuer === srt.issuer);
    return b ? b.balance : undefined;
  };

  console.log('1/3 Payer trustline to SRT');
  if ((await srtBalance()) === undefined) {
    await submit(payer, [Operation.changeTrust({ asset: srt })]);
    console.log('  ✓ added');
  } else console.log('  ✓ already there');

  console.log(`2/3 Depositing ${amount} SRT through ${TESTNET_SRT_ANCHOR.homeDomain} (SEP-24)`);
  const client = new Sep24AnchorClient(payer, Networks.TESTNET);
  const dep = await client.startDeposit(TESTNET_SRT_ANCHOR, amount);
  console.log(`\n  Open this link and complete the test anchor's form (test data only):\n  ${dep.url}\n\n  Waiting for the deposit to complete…`);
  let last = '';
  for (let i = 0; i < 180; i++) {
    const tx = await client.getTransaction(TESTNET_SRT_ANCHOR, dep.id);
    if (tx.status !== last) console.log(`  status: ${(last = tx.status)}`);
    if (tx.status === 'completed') break;
    if (['error', 'expired', 'refunded', 'no_market', 'too_small', 'too_large'].includes(tx.status)) {
      throw new Error(`Deposit ended with status ${tx.status}${tx.message ? `: ${tx.message}` : ''}`);
    }
    await sleep(5000);
  }
  const bal = await srtBalance();
  if (!bal || Number(bal) <= 0) throw new Error('Deposit did not arrive in time; run the command again once it completes.');

  console.log(`3/3 Offering ${bal} SRT for XLM (1 SRT = 1 XLM)`);
  await submit(payer, [Operation.manageSellOffer({ selling: srt, buying: Asset.native(), amount: bal, price: '1' })]);
  console.log(`
Done. AutoFi can now swap XLM -> SRT. To route rewards to the test anchor:
  npm run testnet:prefs -- 60 SRT     (on-chain rule: 60% to SRT)
  set SEP24_ENABLED=true in .env, restart npm run dev, then npm run testnet:reward -- 20`);
}

/** Store an off-ramp rule for the app wallet in the reward_router contract. */
async function prefs(pctArg?: string, codeArg?: string) {
  const env = readEnv();
  const contractId = env.REWARD_ROUTER_CONTRACT_ID;
  if (!env.DEV_PRIVATE_KEY || !contractId) throw new Error('Needs DEV_PRIVATE_KEY and REWARD_ROUTER_CONTRACT_ID in .env (deploy the contract first).');
  const pct = Number(pctArg ?? '70');
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new Error(`Percentage must be 0-100, got "${pctArg}"`);
  const code = (codeArg ?? 'SRT').toUpperCase();
  const issuer = code === 'SRT' ? TESTNET_SRT_ANCHOR.issuer : env[`${code}_ISSUER`];
  if (!issuer) throw new Error(`No issuer known for ${code} (set ${code}_ISSUER in .env)`);

  const wallet = Keypair.fromSecret(env.DEV_PRIVATE_KEY);
  const field = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  // Struct fields must be in alphabetical order.
  const value = xdr.ScVal.scvMap([
    field('anchor_asset_code', nativeToScVal(code, { type: 'string' })),
    field('anchor_issuer', new Address(issuer).toScVal()),
    field('keep_crypto_pct', nativeToScVal(100 - pct, { type: 'u32' })),
    field('off_ramp_pct', nativeToScVal(pct, { type: 'u32' })),
  ]);

  const soroban = new rpc.Server(env.SOROBAN_RPC_URL || SOROBAN_RPC);
  const account = await soroban.getAccount(wallet.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contractId).call('set_preferences', new Address(wallet.publicKey()).toScVal(), value))
    .setTimeout(60)
    .build();
  const prepared = await soroban.prepareTransaction(tx);
  prepared.sign(wallet);
  const sent = await soroban.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`set_preferences rejected: ${JSON.stringify(sent.errorResult)}`);
  for (let i = 0; i < 30; i++) {
    const res = await soroban.getTransaction(sent.hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      console.log(`Stored on-chain: ${pct}% -> ${code}, keep ${100 - pct}%\n  https://stellar.expert/explorer/testnet/tx/${sent.hash}`);
      return;
    }
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error('set_preferences failed on-chain');
    await sleep(2000);
  }
  throw new Error('Timed out waiting for set_preferences to confirm');
}

const [cmd, arg, arg2] = process.argv.slice(2);
const commands: Record<string, (a?: string, b?: string) => Promise<void>> = { setup, reward, balances, anchor, prefs };
const run = commands[cmd ?? ''];
if (!run) {
  console.error('Usage: ts-node scripts/testnet.ts <setup | reward [amount] | balances | anchor [amount] | prefs <pct> <CODE>>');
  process.exit(1);
}
run(arg, arg2).catch((err) => {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
});
