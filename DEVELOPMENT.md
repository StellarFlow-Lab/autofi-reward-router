# Development Guide

## Setup

```bash
npm ci
cp .env.example .env     # DEV_PRIVATE_KEY is the only value you must fill in
```

Get a funded testnet key with `stellar keys generate dev --network testnet --fund` (then `stellar keys show dev`), or from the Stellar Laboratory friendbot.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run from source with ts-node |
| `npm run dev:debug` | Same, with `LOG_LEVEL=debug` |
| `npm run dry-run` | Run with `DRY_RUN=true` (nothing is submitted) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Jest suites in `src/__tests__` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run contract:test` | `cargo test` for the Soroban contract |
| `npm run contract:build` | Build the contract wasm with the stellar CLI |
| `npm run testnet:setup` | Create and fund testnet accounts, open a test NGNX market, write `.env` |
| `npm run testnet:reward -- 25` | Send the app a 25 XLM test reward |
| `npm run testnet:balances` | Show the app wallet's balances |
| `npm run check` | typecheck + test + build + contract:test (what CI runs) |

## Contract toolchain

```bash
rustup target add wasm32v1-none
cargo install --locked stellar-cli
```

The contract targets `soroban-sdk` 25.

## Design notes

- **Idempotency.** Each reward is keyed by its Horizon operation id in the state file (`STATE_FILE`). A reward that was mid-swap when the process died is marked `failed` rather than retried, so a swap is never sent twice. Check it on-chain before retrying.
- **Never-throw pipeline.** `createRewardProcessor` records every outcome (`skipped`, `swapped`, `withdrawal_pending`, `completed`, `failed`) and never throws, so one bad reward can't stop the listener.
- **Preferences.** `FallbackPreferencesProvider` reads the contract first, then `DEFAULT_ANCHOR`/`DEFAULT_OFF_RAMP_PCT`. The on-chain anchor issuer must match the configured issuer, or the reward fails. This guards against a contract value routing funds to an unexpected asset.
- **Slippage.** Swaps quote `strictSendPaths` first and set `destMin` from the best path minus `SLIPPAGE_BPS`.
- **SEP-24.** After a swap, the processor opens an interactive withdrawal and logs the URL (one-time KYC may be needed). `withdrawalMonitor` polls the anchor and, with `SEP24_AUTO_SEND`, sends the asset when the anchor reports `pending_user_transfer_start`. If opening the withdrawal fails, the funds stay in the anchor asset and can be retried with `POST /rewards/:id/withdraw`.

## Adding an anchor

Add a template to `TEMPLATES` in `src/config/anchors.ts` with its code, fiat currency and home domain. It is enabled when `<CODE>_ISSUER` is set (or when a default issuer is built in).

## Testing

Tests use in-memory fakes from `src/__tests__/helpers.ts`. Nothing touches the network.
