# AutoFi Reward Router

Automatically off-ramps developer rewards (Drips Wave payouts, GitHub bounties) to local fiat.

When a reward lands in your Stellar wallet, AutoFi reads your split rule from a Soroban contract, swaps the off-ramp share into an anchor stablecoin on the Stellar DEX, and opens a SEP-24 withdrawal so the money reaches your bank or mobile-money account in NGN, USD or GBP.

## How it works

```
 Drips / bounty payout ──► Stellar account
                               │  Horizon payments, polled with a saved cursor (paymentListener)
                               ▼
                         rewardProcessor
   1. idempotency check (stateStore)
   2. read split rule ──────────────► reward_router contract (Soroban)
   3. compute off-ramp share             or DEFAULT_ANCHOR fallback
   4. swap ─────────────────────────► pathPaymentStrictSend, slippage-protected
   5. open SEP-24 withdrawal ───────► anchor (SEP-10 auth + SEP-24)
                               │
                               ▼
                       withdrawalMonitor
   polls the anchor, sends the asset when it's ready, marks the reward completed
```

The HTTP server exposes health, metrics, reward history, a withdrawal-retry endpoint and a signed GitHub webhook for bounty notices.

## Project layout

```
contracts/reward_router/   Soroban contract storing RoutePreferences per developer
src/
  index.ts                 entrypoint: loads .env, starts the app, handles shutdown
  app.ts                   wires every component together
  config/                  env parsing/validation, anchor registry
  core/                    rewardProcessor (pipeline), withdrawalMonitor (SEP-24 polling)
  services/                Horizon listener, wallet/DEX swaps, Soroban client,
                           SEP-24 anchor client, state store, rate limiter
  server/                  HTTP server and GitHub webhook parsing
  utils/                   amount math, validation, logging, metrics, retry
  __tests__/               Jest test suites
web/                       browser app: connect wallet, set split rule, view payouts
scripts/testnet.ts         testnet kit: set up a test wallet and send it rewards
```

## Quick start

Requires Node.js 22.12+.

```bash
npm ci
cp .env.example .env      # set DEV_PRIVATE_KEY at minimum
npm run build
npm start                 # or: npm run dev
```

The example config runs on testnet in dry-run mode, routing 70% of each reward to Stellar's reference anchor (SRT), so you can try the full flow without real funds. Set `DRY_RUN=false` to submit transactions.

## Try it on testnet (5 minutes, no real money)

```bash
npm ci
npm run testnet:setup          # creates + funds test accounts, opens a test NGNX market, writes .env
npm run dev                    # start AutoFi and leave it running
```

In a second terminal:

```bash
npm run testnet:reward -- 25   # a "Drips" payer sends your wallet 25 XLM
npm run testnet:balances       # ~17.5 XLM swapped to NGNX, the rest kept as XLM
curl localhost:8080/rewards    # the reward's full history
```

What happens: AutoFi sees the payment, reads the split (70% off-ramp by default), swaps that share into NGNX on the testnet DEX with slippage protection, and records the result.

### Test the full cash-out with Stellar's test anchor

The kit can also run the bank step end to end against `testanchor.stellar.org` (SEP-10 + SEP-24):

```bash
npm run testnet:anchor          # get 10 test SRT via the anchor (opens a test form) and offer it on the DEX
npm run testnet:prefs -- 60 SRT # with REWARD_ROUTER_CONTRACT_ID set: store "60% to SRT" on-chain
# set SEP24_ENABLED=true in .env, then restart: npm run dev
npm run testnet:reward -- 50    # 30 XLM is swapped to SRT and a withdrawal is opened
```

Open the link AutoFi logs (or the **Finish cash-out** link in the web app), complete the test anchor's form, and AutoFi sends the SRT and marks the payout `completed`. The test anchor accepts 1–10 SRT per transaction.

Add `ALERT_WEBHOOK_URL` (a Slack or Discord webhook) to get a message for every payout or failure.

## Web app

`web/` is a small browser app for developers:

- **Connect** the Freighter wallet (testnet).
- **Set your split rule:** off-ramp share and cash-out anchor, signed by your wallet and stored in the `reward_router` contract.
- **See payouts** from your AutoFi server, with status, explorer links and a **Finish cash-out** link when the anchor is waiting on you.

```bash
cd web && npm ci && npm run dev     # or from the root: npm run web:dev
```

It's published to GitHub Pages by `.github/workflows/pages.yml` on every push to `main` that touches `web/`. To let the hosted app read your server's payouts, set `CORS_ORIGIN=https://stellarflow-lab.github.io` (and `ADMIN_TOKEN`, entered in the app's Settings). Defaults for the contract, RPC and server URL are in `web/.env.example`.

## Deploy with Docker

```bash
cp .env.example .env      # fill it in (mainnet needs ADMIN_TOKEN)
docker compose up -d --build
docker compose logs -f
```

The container runs as a non-root user, keeps its state on the `autofi-data` volume, restarts automatically, and is marked unhealthy when `/health` returns 503. The port is bound to `127.0.0.1`; put a TLS reverse proxy in front if the web app or GitHub webhook needs to reach it. Keep `HTTP_PORT` at 8080 inside the container.

## Smart contract

```bash
npm run contract:test     # cargo test
npm run contract:build    # stellar contract build (needs the stellar CLI + wasm32v1-none target)

stellar contract deploy \
  --wasm contracts/reward_router/target/wasm32v1-none/release/reward_router.wasm \
  --source <identity> --network testnet
```

Put the returned `C...` id in `REWARD_ROUTER_CONTRACT_ID`.

| Function | Auth | Description |
|---|---|---|
| `set_preferences(user, prefs)` | `user` | Store the split. `off_ramp_pct + keep_crypto_pct` must equal 100 (`InvalidSplit`); asset code 1-12 chars (`InvalidAssetCode`). |
| `get_preferences(user)` | — | Read the split (`NotFound` error if unset). |
| `has_preferences(user)` | — | Whether a split is stored. |
| `remove_preferences(user)` | `user` | Delete the split (`NotFound` if unset); AutoFi falls back to defaults. |

The contract emits `PreferencesSet` and `PreferencesRemoved` events, and extends the storage TTL (~30 days) on every read and write.

## HTTP API

| Route | Auth | Description |
|---|---|---|
| `GET /health` | — | Status, network, account, anchors; **503** if Horizon hasn't been reached for 2 min |
| `GET /metrics` | — | Counters and processing times |
| `GET /rewards?status=&limit=` | admin | Processed reward records |
| `POST /rewards/:id/withdraw` | admin | Retry opening a SEP-24 withdrawal |
| `POST /webhooks/github` | signature | GitHub bounty webhook (`GITHUB_WEBHOOK_SECRET`) |

Admin routes take `Authorization: Bearer $ADMIN_TOKEN`.

## Configuration

Every option is documented in [.env.example](.env.example). Configuration is validated at startup, and all problems are reported together.

## Development

```bash
npm test                  # Jest
npm run typecheck
npm run check             # typecheck + tests + build + contract tests
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for more.

## Roadmap

- [x] Soroban preferences client
- [x] On-chain reward listener (Horizon, resumable cursor)
- [x] Slippage-protected DEX swap
- [x] SEP-24 withdrawal + status polling
- [x] Signed GitHub bounty webhook
- [ ] Drips subgraph lookup to attribute payouts to specific streams
- [ ] Multi-account support from one instance
- [x] Web UI for setting `RoutePreferences` and viewing history

## License

MIT
