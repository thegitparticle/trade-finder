import React, { useEffect, useMemo, useState } from 'https://esm.sh/react@18.2.0'
import { createRoot } from 'https://esm.sh/react-dom@18.2.0/client'
import htm from 'https://esm.sh/htm@3.1.1'

const html = htm.bind(React.createElement)

function App() {
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const lastUpdated = useMemo(() => (snapshot?.generatedAt ? new Date(snapshot.generatedAt).toLocaleString() : '—'), [snapshot])

  const refreshData = async (force = false) => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`/api/markets${force ? '?refresh=1' : ''}`)
      if (!response.ok) throw new Error(`Failed to fetch market snapshot: ${response.status}`)
      setSnapshot(await response.json())
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

  const signals = snapshot?.signals || []
  const markets = snapshot?.markets || []

  return html`
    <div className="page">
      <${Header} />
      <main className="container">
        <div className="page-header">
          <p className="muted mono">Last updated: ${lastUpdated}</p>
          <p className="muted mono">Schedule: ${snapshot?.schedule || '5 * * * *'} (hourly cron + buffer)</p>
        </div>

        <section className="card">
          <div className="card-actions spread">
            <div>
              <div className="card-label mono">Multi-Strategy Signals</div>
              <div className="muted mono">Regime-routed TFP/TBO/MRE signals (confidence ≥ ${snapshot?.config?.suppressBelow ?? 60})</div>
            </div>
            <button className="button button-orange" onClick=${() => refreshData(true)}>
              ${loading ? 'Refreshing...' : 'Refresh now'}
            </button>
          </div>
          ${error
            ? html`<p className="error mono">${error}</p>`
            : signals.length
              ? html`
                  <div className="signal-list">
                    ${signals.map(
                      (signal) => html`
                        <div className="signal-item">
                          <div className="signal-title mono">${signal.token} • ${signal.strategy} • ${signal.side}</div>
                          <div className="signal-value">${signal.tier} • Confidence ${signal.confidence}</div>
                          <div className="muted mono">
                            Entry ${formatPrice(signal.entry?.trigger_price)} • SL ${formatPrice(signal.invalidation?.stop_loss)} •
                            TP1 ${formatPrice(signal.targets?.tp1)}
                          </div>
                          <div className="muted mono">Expires: ${formatTimestamp(signal.expires_at)} • Regime: ${signal.regime}</div>
                        </div>
                      `
                    )}
                  </div>
                `
              : html`<p className="muted mono">No surfaced signals this scan cycle.</p>`}
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
          <h1>Signal Engine Monitor</h1>
          <span className="muted mono">Hyperliquid • Multi-strategy • Cloudflare Workers</span>
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
        <p className="muted mono">Signals include confidence, invalidation, targets, and expiry.</p>
      </div>
    </footer>
  `
}

function MarketCard({ market }) {
  return html`
    <article className="card market-card">
      <div className="card-actions spread">
        <div>
          <div className="card-label mono">${market.id}</div>
          <div className="card-value">Regime ${market.regime || '—'}</div>
        </div>
        <div className="price mono">ADX4h ${formatMetric(market.indicators?.adx4h)}</div>
      </div>

      ${market.error
        ? html`<p className="error mono">${market.error}</p>`
        : html`
            <div className="stats-grid mono">
              <div>EMA200 slope 4h: <strong>${formatMetric(market.indicators?.ema200Slope4h)}</strong></div>
              <div>BBW 4h: <strong>${formatMetric(market.indicators?.bbw4h)}</strong></div>
              <div>BBW median 30: <strong>${formatMetric(market.indicators?.bbw4hMedian30)}</strong></div>
              <div>Candidate: <strong>${market.signalCandidate ? `${market.signalCandidate.strategy || 'N/A'} ${market.signalCandidate.side || ''}` : 'None'}</strong></div>
              <div>Candidate confidence: <strong>${formatMetric(market.signalCandidate?.confidence)}</strong></div>
              <div>Suppressed: <strong>${market.signalSuppressed ? 'Yes' : 'No'}</strong></div>
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

  return html`<button className="button button-green" onClick=${() => setTheme(theme === 'light' ? 'dark' : 'light')}>Toggle Theme</button>`
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

  return html`<button className="button button-orange" onClick=${() => setDense(!dense)}>Compact</button>`
}

function formatMetric(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function formatPrice(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  if (Math.abs(value) >= 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}`
}

function formatTimestamp(value) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString()
}

const rootElement = document.getElementById('app')
if (!rootElement) throw new Error('Root element #app not found')

createRoot(rootElement).render(html`<${App} />`)
