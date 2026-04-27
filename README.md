# dashboard-boilerplate

RSI trade dashboard built on top of the boilerplate design system. The app is deployment-ready for **Cloudflare Workers** with hourly cron ingestion.

## What it does

- Pulls hourly and daily candle data from Hyperliquid for: **BTC, ETH, SOL, HYPE, BNB, CI, SILVER, GOLD**.
  - Commodity markets use fallback symbol probing (`CI|WTI|USOIL`, `SILVER|XAG`, `GOLD|XAU`) to reduce deploy-time symbol mismatch risk.
- Computes RSI(14) on hourly closes.
- Generates hourly snapshot analytics:
  - current RSI
  - 24h RSI mean/median/high/low
  - 1h and 24h price % moves
  - latest hourly OHLCV
  - latest daily OHLCV
- Shows **Live Trade Finder** section for any market where live RSI <= 25.

## Local development

```bash
npm run dev
```

This starts `dev-server.js` and exposes `/api/markets`.

## Cloudflare Workers deployment

### 1) Create KV namespace (optional but recommended)

```bash
npx wrangler kv namespace create MARKET_CACHE
npx wrangler kv namespace create MARKET_CACHE --preview
```

Then add the binding as `MARKET_CACHE` in one of these ways:

- **Cloudflare dashboard (recommended for CI-connected builds):**
  - Worker → Settings → Bindings → KV Namespace
  - Binding name: `MARKET_CACHE`
- **or CLI/local config:**
  - add `kv_namespaces` in `wrangler.jsonc` (or environment-specific config) using the generated IDs.

### 2) Run worker locally

```bash
npm run dev:worker
```

### 3) Deploy

```bash
npm run deploy
```

## Pre-deploy sanity checks

```bash
node --check public/app/main.js
node --check dev-server.js
node --check worker.js
```

## Cron schedule

The worker includes:

- `triggers.crons = ["0 * * * *"]`
- `scheduled()` handler that refreshes market snapshot every hour and writes to KV.

`/api/markets` returns cached snapshot and can be forced with `?refresh=1`.

## Static assets

- Worker uploads frontend assets from `./public` only (prevents uploading repo internals like `.git`).
