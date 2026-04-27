const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info'
const HOURLY_INTERVAL = '1h'
const DAILY_INTERVAL = '1d'
const RSI_PERIOD = 14
const SNAPSHOT_KV_KEY = 'market-snapshot-v1'

const MARKETS = [
  { id: 'BTC', coins: ['BTC'], label: 'Bitcoin' },
  { id: 'ETH', coins: ['ETH'], label: 'Ethereum' },
  { id: 'SOL', coins: ['SOL'], label: 'Solana' },
  { id: 'HYPE', coins: ['HYPE'], label: 'Hyperliquid' },
  { id: 'BNB', coins: ['BNB'], label: 'BNB' },
  { id: 'CI', coins: ['CI', 'WTI', 'USOIL'], label: 'Crude Oil' },
  { id: 'SILVER', coins: ['SILVER', 'XAG'], label: 'Silver' },
  { id: 'GOLD', coins: ['GOLD', 'XAU'], label: 'Gold' },
]

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname === '/api/markets') {
      const force = url.searchParams.get('refresh') === '1'
      const snapshot = await getOrRefreshSnapshot(env, force)
      return json(snapshot)
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, now: new Date().toISOString() })
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request)
    }

    return new Response('Not found', { status: 404 })
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshAndPersistSnapshot(env))
  },
}

async function getOrRefreshSnapshot(env, forceRefresh = false) {
  if (!forceRefresh && env.MARKET_CACHE) {
    const existing = await env.MARKET_CACHE.get(SNAPSHOT_KV_KEY, 'json')
    if (existing) {
      return existing
    }
  }

  return refreshAndPersistSnapshot(env)
}

async function refreshAndPersistSnapshot(env) {
  const now = Date.now()
  const oneHourMs = 60 * 60 * 1000
  const oneDayMs = 24 * oneHourMs
  const hourlyStart = now - 72 * oneHourMs
  const dailyStart = now - 30 * oneDayMs

  const marketResults = await Promise.all(
    MARKETS.map(async (market) => {
      try {
        const { coin, hourlyCandles, dailyCandles } = await fetchMarketCandles(market, hourlyStart, dailyStart, now)

        if (!hourlyCandles.length) {
          throw new Error('No hourly candle data returned')
        }

        const closes = hourlyCandles.map((candle) => candle.close)
        const rsiSeries = calculateRsiSeries(closes, RSI_PERIOD)
        const currentRsi = rsiSeries.length ? round(rsiSeries[rsiSeries.length - 1], 2) : null

        const recentRsi = rsiSeries.slice(-24)
        const meanRsi = recentRsi.length ? round(mean(recentRsi), 2) : null
        const medianRsi = recentRsi.length ? round(median(recentRsi), 2) : null
        const rsiHigh = recentRsi.length ? round(Math.max(...recentRsi), 2) : null
        const rsiLow = recentRsi.length ? round(Math.min(...recentRsi), 2) : null

        const currentPrice = closes.at(-1)
        const previousHourClose = closes.at(-2)
        const close24hAgo = closes.length > 24 ? closes.at(-25) : null

        const priceChange1hPct =
          previousHourClose && currentPrice
            ? round(((currentPrice - previousHourClose) / previousHourClose) * 100, 3)
            : null
        const priceChange24hPct =
          close24hAgo && currentPrice ? round(((currentPrice - close24hAgo) / close24hAgo) * 100, 3) : null

        const latestHourly = hourlyCandles.at(-1)

        return {
          id: market.id,
          label: market.label,
          coin,
          currentPrice: currentPrice ? round(currentPrice, 6) : null,
          currentRsi,
          rsi24hMean: meanRsi,
          rsi24hMedian: medianRsi,
          rsi24hHigh: rsiHigh,
          rsi24hLow: rsiLow,
          priceChange1hPct,
          priceChange24hPct,
          latestHourlyOhlcv: latestHourly || null,
          dailyOhlcv: dailyCandles,
          source: 'hyperliquid',
          error: null,
        }
      } catch (error) {
        return {
          id: market.id,
          label: market.label,
          coin: market.coins[0],
          currentPrice: null,
          currentRsi: null,
          rsi24hMean: null,
          rsi24hMedian: null,
          rsi24hHigh: null,
          rsi24hLow: null,
          priceChange1hPct: null,
          priceChange24hPct: null,
          latestHourlyOhlcv: null,
          dailyOhlcv: [],
          source: 'hyperliquid',
          error: error instanceof Error ? error.message : `No usable symbol for ${market.id}`,
        }
      }
    })
  )

  const liveTradeFinder = marketResults
    .filter((market) => typeof market.currentRsi === 'number' && market.currentRsi <= 25)
    .sort((a, b) => a.currentRsi - b.currentRsi)
    .map((market) => ({
      id: market.id,
      label: market.label,
      currentPrice: market.currentPrice,
      currentRsi: market.currentRsi,
      priceChange24hPct: market.priceChange24hPct,
    }))

  const snapshot = {
    generatedAt: new Date().toISOString(),
    schedule: '0 * * * *',
    note: 'Hourly RSI analysis generated from Hyperliquid candles.',
    markets: marketResults,
    liveTradeFinder,
  }

  if (env.MARKET_CACHE) {
    await env.MARKET_CACHE.put(SNAPSHOT_KV_KEY, JSON.stringify(snapshot), {
      expirationTtl: 60 * 60 * 6,
    })
  }

  return snapshot
}

async function fetchCandles(coin, interval, startTime, endTime) {
  const response = await fetch(HYPERLIQUID_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'candleSnapshot',
      req: {
        coin,
        interval,
        startTime,
        endTime,
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch ${coin} (${interval}) - HTTP ${response.status}`)
  }

  const payload = await response.json()
  if (!Array.isArray(payload)) {
    throw new Error(`Unexpected candle payload for ${coin} (${interval})`)
  }

  return payload
    .map((item) => ({
      startTime: Number(item.t),
      endTime: Number(item.T),
      open: Number(item.o),
      high: Number(item.h),
      low: Number(item.l),
      close: Number(item.c),
      volume: Number(item.v),
      trades: Number(item.n),
    }))
    .filter((item) => Number.isFinite(item.close))
}

async function fetchMarketCandles(market, hourlyStart, dailyStart, now) {
  const errors = []

  for (const coin of market.coins) {
    try {
      const [hourlyCandles, dailyCandles] = await Promise.all([
        fetchCandles(coin, HOURLY_INTERVAL, hourlyStart, now),
        fetchCandles(coin, DAILY_INTERVAL, dailyStart, now),
      ])

      if (!hourlyCandles.length) {
        throw new Error(`No hourly candle data returned for ${coin}`)
      }

      return { coin, hourlyCandles, dailyCandles }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${coin}: ${message}`)
    }
  }

  throw new Error(`No symbol matched for ${market.id}. Attempts -> ${errors.join(' | ')}`)
}

function calculateRsiSeries(closes, period) {
  if (closes.length <= period) {
    return []
  }

  const gains = []
  const losses = []

  for (let i = 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1]
    gains.push(Math.max(delta, 0))
    losses.push(Math.max(-delta, 0))
  }

  let avgGain = mean(gains.slice(0, period))
  let avgLoss = mean(losses.slice(0, period))
  const rsi = [calculateSingleRsi(avgGain, avgLoss)]

  for (let i = period; i < gains.length; i += 1) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period
    rsi.push(calculateSingleRsi(avgGain, avgLoss))
  }

  return rsi
}

function calculateSingleRsi(avgGain, avgLoss) {
  if (avgLoss === 0) {
    return 100
  }

  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function mean(values) {
  if (!values.length) {
    return 0
  }

  const total = values.reduce((sum, value) => sum + value, 0)
  return total / values.length
}

function median(values) {
  if (!values.length) {
    return 0
  }

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }

  return sorted[middle]
}

function round(value, decimals) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function json(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  })
}
