# trade-finder

Multi-strategy signal dashboard built for **Cloudflare Workers** with hourly Hyperliquid ingestion.

## What it does

- Scans a fixed 6-token universe: **ETH, BTC, SOL, DOGE, PEPE, XRP**.
- Fetches **1h / 4h / 1d** OHLCV candles from Hyperliquid.
- Classifies each token into one regime every hour:
  - `TRENDING` → Trend-Following Pullback (TFP)
  - `SQUEEZE` → Trend Breakout (TBO)
  - `RANGING` → Mean Reversion Extremes (MRE)
  - `TRANSITIONAL` → no strategy fired
- Evaluates only the strategy allowed by the active regime.
- Scores setup confidence from **0–100** and suppresses low-confidence candidates (< 60).
- Produces signal payloads with entry zone, invalidation, targets, risk parameters, context, and score breakdown.
- Stores active signal dedup state and snapshot data in KV (`MARKET_CACHE`) when available.

## Config

- Strategy/regime thresholds are documented in `signal-engine-config.yml`.
- Worker runtime currently uses an equivalent in-code config object; keep it aligned with this YAML file when tuning thresholds.

## Local development

```bash
npm run dev
```

This starts `dev-server.js` and exposes `/api/markets` on port `5173` by default.

Open one of:
- `http://localhost:5173`
- `http://127.0.0.1:5173`

If you still see `127.0.0.1 refused to connect`, verify the server process is running and restart with:

```bash
npm run dev
```

## Cloudflare Workers deployment

### 1) Create KV namespace (optional but recommended)

```bash
npx wrangler kv namespace create MARKET_CACHE
npx wrangler kv namespace create MARKET_CACHE --preview
```

Then bind the namespace as `MARKET_CACHE`.

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

- `triggers.crons = ["5 * * * *"]`
- `scheduled()` refreshes the signal snapshot each hour after the 1h candle close buffer.

`/api/markets` returns cached snapshot and supports force refresh with `?refresh=1`.
