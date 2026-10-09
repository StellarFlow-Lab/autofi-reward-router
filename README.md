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
```

## Quick start

Requires Node.js 20.12+.

```bash
npm ci
cp .env.example .env      # set DEV_PRIVATE_KEY at minimum
npm run build
npm start                 # or: npm run dev
```

The example config runs on testnet in dry-run mode, routing 70% of each reward to Stellar's reference anchor (SRT), so you can try the full flow without real funds. Set `DRY_RUN=false` to submit transactions.

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
| `set_preferences(user, prefs)` | `user` | Store the split. `off_ramp_pct + keep_crypto_pct` must equal 100. |
| `get_preferences(user)` | — | Read the split (panics if unset). |
| `has_preferences(user)` | — | Whether a split is stored. |
| `remove_preferences(user)` | `user` | Delete the split; AutoFi falls back to defaults. |

## HTTP API

| Route | Auth | Description |
|---|---|---|
| `GET /health` | — | Status, network, account, enabled anchors |
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
- [ ] Web UI for setting `RoutePreferences` and viewing history

## License

MIT
