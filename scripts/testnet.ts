/**
 * Testnet kit: set up a wallet you can try AutoFi with, then send it rewards.
 *
 *   npm run testnet:setup            create + fund accounts, seed a DEX market, write .env
 *   npm run testnet:reward -- 25     pay the app 25 XLM from the "Drips" payer account
 *   npm run testnet:balances         show the app wallet's balances
 *
 * Testnet only. Nothing here can touch mainnet funds.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const HORIZON = 'https://horizon-testnet.stellar.org';
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

async function submit(signer: Keypair, ops: ReturnType<typeof Operation.payment>[]): Promise<string> {
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

const [cmd, arg] = process.argv.slice(2);
const commands: Record<string, (a?: string) => Promise<void>> = { setup, reward, balances };
const run = commands[cmd ?? ''];
if (!run) {
  console.error('Usage: ts-node scripts/testnet.ts <setup|reward [amount]|balances>');
  process.exit(1);
}
run(arg).catch((err) => {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
});
