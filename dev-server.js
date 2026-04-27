const http = require('http')
const fs = require('fs')
const path = require('path')
const url = require('url')

const port = process.env.PORT ? Number(process.env.PORT) : 5173
const rootDir = __dirname
const staticDir = path.join(rootDir, 'public')
const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info'
const RSI_PERIOD = 14

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

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400)
    res.end('Bad request')
    return
  }

  const { pathname } = url.parse(req.url)

  if (pathname === '/api/markets') {
    try {
      const payload = await buildSnapshot()
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: error.message || 'Failed to build snapshot' }))
    }
    return
  }

  const safePath = pathname === '/' ? '/index.html' : pathname
  const filePath = path.join(staticDir, decodeURIComponent(safePath))

  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const ext = path.extname(filePath)
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' })
    res.end(data)
  })
})

server.listen(port, () => {
  console.log(`Dev server running at http://localhost:${port}`)
})

async function buildSnapshot() {
  const now = Date.now()
  const oneHourMs = 60 * 60 * 1000
  const oneDayMs = 24 * oneHourMs
  const hourlyStart = now - 72 * oneHourMs
  const dailyStart = now - 30 * oneDayMs

  const markets = await Promise.all(
    MARKETS.map(async (market) => {
      try {
        const { coin, hourlyCandles, dailyCandles } = await fetchMarketCandles(market, hourlyStart, dailyStart, now)

        const closes = hourlyCandles.map((candle) => candle.close)
        const rsiSeries = calculateRsiSeries(closes, RSI_PERIOD)
        const currentRsi = rsiSeries.length ? round(rsiSeries[rsiSeries.length - 1], 2) : null
        const recentRsi = rsiSeries.slice(-24)

        const currentPrice = closes.at(-1)
        const previousHourClose = closes.at(-2)
        const close24hAgo = closes.length > 24 ? closes.at(-25) : null

        return {
          id: market.id,
          label: market.label,
          coin,
          currentPrice: currentPrice ? round(currentPrice, 6) : null,
          currentRsi,
          rsi24hMean: recentRsi.length ? round(mean(recentRsi), 2) : null,
          rsi24hMedian: recentRsi.length ? round(median(recentRsi), 2) : null,
          rsi24hHigh: recentRsi.length ? round(Math.max(...recentRsi), 2) : null,
          rsi24hLow: recentRsi.length ? round(Math.min(...recentRsi), 2) : null,
          priceChange1hPct:
            previousHourClose && currentPrice
              ? round(((currentPrice - previousHourClose) / previousHourClose) * 100, 3)
              : null,
          priceChange24hPct:
            close24hAgo && currentPrice ? round(((currentPrice - close24hAgo) / close24hAgo) * 100, 3) : null,
          latestHourlyOhlcv: hourlyCandles.at(-1) || null,
          dailyOhlcv: dailyCandles,
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
          error: error.message || `No usable symbol for ${market.id}`,
        }
      }
    })
  )

  return {
    generatedAt: new Date().toISOString(),
    schedule: '0 * * * *',
    markets,
    liveTradeFinder: markets
      .filter((market) => typeof market.currentRsi === 'number' && market.currentRsi <= 25)
      .sort((a, b) => a.currentRsi - b.currentRsi)
      .map((market) => ({
        id: market.id,
        label: market.label,
        currentPrice: market.currentPrice,
        currentRsi: market.currentRsi,
        priceChange24hPct: market.priceChange24hPct,
      })),
  }
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
    throw new Error(`Failed to fetch ${coin}/${interval}: ${response.status}`)
  }

  const payload = await response.json()
  if (!Array.isArray(payload)) {
    throw new Error(`Invalid candle payload for ${coin}/${interval}`)
  }

  return payload.map((item) => ({
    startTime: Number(item.t),
    endTime: Number(item.T),
    open: Number(item.o),
    high: Number(item.h),
    low: Number(item.l),
    close: Number(item.c),
    volume: Number(item.v),
    trades: Number(item.n),
  }))
}

async function fetchMarketCandles(market, hourlyStart, dailyStart, now) {
  const attempts = []

  for (const coin of market.coins) {
    try {
      const [hourlyCandles, dailyCandles] = await Promise.all([
        fetchCandles(coin, '1h', hourlyStart, now),
        fetchCandles(coin, '1d', dailyStart, now),
      ])

      if (!hourlyCandles.length) {
        throw new Error(`No hourly candle data returned for ${coin}`)
      }

      return { coin, hourlyCandles, dailyCandles }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      attempts.push(`${coin}: ${message}`)
    }
  }

  throw new Error(`No symbol matched for ${market.id}. Attempts -> ${attempts.join(' | ')}`)
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
  const rsi = [singleRsi(avgGain, avgLoss)]

  for (let i = period; i < gains.length; i += 1) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period
    rsi.push(singleRsi(avgGain, avgLoss))
  }

  return rsi
}

function singleRsi(avgGain, avgLoss) {
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
  return values.reduce((sum, value) => sum + value, 0) / values.length
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
