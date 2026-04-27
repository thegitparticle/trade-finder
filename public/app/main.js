import React, { useEffect, useMemo, useState } from 'https://esm.sh/react@18.2.0'
import { createRoot } from 'https://esm.sh/react-dom@18.2.0/client'
import htm from 'https://esm.sh/htm@3.1.1'

const html = htm.bind(React.createElement)

function App() {
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const lastUpdated = useMemo(() => {
    return snapshot?.generatedAt ? new Date(snapshot.generatedAt).toLocaleString() : '—'
  }, [snapshot])

  const refreshData = async (force = false) => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`/api/markets${force ? '?refresh=1' : ''}`)
      if (!response.ok) {
        throw new Error(`Failed to fetch market snapshot: ${response.status}`)
      }
      const json = await response.json()
      setSnapshot(json)
    } catch (fetchError) {
      console.error(fetchError)
      setError(fetchError instanceof Error ? fetchError.message : 'Unknown fetch error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refreshData()
  }, [])

  const liveSignals = snapshot?.liveTradeFinder || []
  const markets = snapshot?.markets || []

  return html`
    <div className="page">
      <div className="scanline" aria-hidden="true"></div>
      <${Header} />
      <main className="container">
        <div className="page-header">
          <p className="muted mono">Last updated: ${lastUpdated}</p>
          <p className="muted mono">Schedule: ${snapshot?.schedule || '0 * * * *'} (hourly cron)</p>
        </div>

        <section className="card">
          <div className="card-actions spread">
            <div>
              <div className="card-label mono">Live Trade Finder</div>
              <div className="muted mono">Markets with RSI ≤ 25 on 1h candles</div>
            </div>
            <button className="button button-orange" onClick=${() => refreshData(true)}>
              ${loading ? 'Refreshing...' : 'Refresh now'}
            </button>
          </div>
          ${error
            ? html`<p className="error mono">${error}</p>`
            : liveSignals.length
              ? html`
                  <div className="signal-list">
                    ${liveSignals.map(
                      (signal) => html`
                        <div className="signal-item">
                          <div className="signal-title mono">${signal.id}</div>
                          <div className="signal-value">RSI ${formatMetric(signal.currentRsi)}</div>
                          <div className="muted mono">
                            Price ${formatPrice(signal.currentPrice)} • 24h ${formatPct(signal.priceChange24hPct)}
                          </div>
                        </div>
                      `
                    )}
                  </div>
                `
              : html`<p className="muted mono">No live RSI opportunities ≤ 25 right now.</p>`}
        </section>

        <section className="grid market-grid">
          ${markets.map((market) => html`<${MarketCard} key=${market.id} market=${market} />`)}
        </section>
      </main>
      <${Footer} />
    </div>
  `
}

function Header() {
  return html`
    <header className="header">
      <div className="container header-inner">
        <div className="brand">
          <h1>RSI Trade Dashboard</h1>
          <span className="muted mono">Hyperliquid • Hourly scan • Cloudflare Workers</span>
        </div>
        <div className="controls">
          <${ThemeToggle} />
          <${CompactToggle} />
        </div>
      </div>
    </header>
  `
}

function Footer() {
  return html`
    <footer className="footer">
      <div className="container">
        <p className="muted mono">Cloudflare Worker + hourly cron + KV cache snapshot</p>
      </div>
    </footer>
  `
}

function MarketCard({ market }) {
  return html`
    <article className="card market-card">
      <div className="card-actions spread">
        <div>
          <div className="card-label mono">${market.label}</div>
          <div className="card-value">${market.id}</div>
        </div>
        <div className="price mono">${formatPrice(market.currentPrice)}</div>
      </div>

      ${market.error
        ? html`<p className="error mono">${market.error}</p>`
        : html`
            <div className="stats-grid mono">
              <div>RSI (now): <strong>${formatMetric(market.currentRsi)}</strong></div>
              <div>RSI mean 24h: <strong>${formatMetric(market.rsi24hMean)}</strong></div>
              <div>RSI median 24h: <strong>${formatMetric(market.rsi24hMedian)}</strong></div>
              <div>RSI high 24h: <strong>${formatMetric(market.rsi24hHigh)}</strong></div>
              <div>RSI low 24h: <strong>${formatMetric(market.rsi24hLow)}</strong></div>
              <div>Price 1h %: <strong>${formatPct(market.priceChange1hPct)}</strong></div>
              <div>Price 24h %: <strong>${formatPct(market.priceChange24hPct)}</strong></div>
            </div>

            <div className="ohlcv mono">
              <div className="card-label mono">Latest hourly OHLCV</div>
              ${market.latestHourlyOhlcv
                ? html`
                    <div>
                      O ${formatPrice(market.latestHourlyOhlcv.open)} • H ${formatPrice(market.latestHourlyOhlcv.high)} •
                      L ${formatPrice(market.latestHourlyOhlcv.low)} • C ${formatPrice(market.latestHourlyOhlcv.close)} • V
                      ${formatMetric(market.latestHourlyOhlcv.volume)}
                    </div>
                  `
                : html`<div className="muted">No hourly OHLCV data</div>`}
            </div>

            <div className="ohlcv mono">
              <div className="card-label mono">Daily OHLCV (latest)</div>
              ${market.dailyOhlcv && market.dailyOhlcv.length
                ? html`
                    <div>
                      O ${formatPrice(market.dailyOhlcv.at(-1).open)} • H ${formatPrice(market.dailyOhlcv.at(-1).high)} •
                      L ${formatPrice(market.dailyOhlcv.at(-1).low)} • C ${formatPrice(market.dailyOhlcv.at(-1).close)} • V
                      ${formatMetric(market.dailyOhlcv.at(-1).volume)}
                    </div>
                  `
                : html`<div className="muted">No daily OHLCV data</div>`}
            </div>
          `}
    </article>
  `
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('theme') || 'light'
    } catch {
      return 'light'
    }
  })

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
      localStorage.setItem('theme', 'dark')
    } else {
      root.classList.remove('dark')
      localStorage.setItem('theme', 'light')
    }
  }, [theme])

  return html`
    <button className="button button-green" onClick=${() => setTheme(theme === 'light' ? 'dark' : 'light')}>
      Toggle Theme
    </button>
  `
}

function CompactToggle() {
  const [dense, setDense] = useState(() => {
    try {
      return localStorage.getItem('dense') === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    const root = document.documentElement
    if (dense) {
      root.classList.add('dense')
      localStorage.setItem('dense', '1')
    } else {
      root.classList.remove('dense')
      localStorage.removeItem('dense')
    }
  }, [dense])

  return html`
    <button className="button button-orange" onClick=${() => setDense(!dense)}>Compact</button>
  `
}

function formatMetric(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—'
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatPrice(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—'
  }

  if (Math.abs(value) >= 1000) {
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  }

  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}`
}

function formatPct(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—'
  }

  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(3)}%`
}

const rootElement = document.getElementById('app')

if (!rootElement) {
  throw new Error('Root element #app not found')
}

const root = createRoot(rootElement)
root.render(html`<${App} />`)
