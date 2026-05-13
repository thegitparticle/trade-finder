import React, { useEffect, useMemo, useState } from 'https://esm.sh/react@18.2.0'
import { createRoot } from 'https://esm.sh/react-dom@18.2.0/client'
import htm from 'https://esm.sh/htm@3.1.1'

const html = htm.bind(React.createElement)

const STRATEGY_LABELS = {
  TFP: 'Trend Pullback (TFP)',
  TBO: 'Trend Breakout (TBO)',
  MRE: 'Mean Reversion Extremes (MRE)',
}

function App() {
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sortBy, setSortBy] = useState('actionability')

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
  const history = snapshot?.history || []
  const suppressBelow = snapshot?.config?.suppressBelow ?? 60

  const summary = useMemo(() => {
    const actionable = markets.filter((m) => typeof m.signalCandidate?.confidence === 'number' && m.signalCandidate.confidence >= 75 && !m.signalSuppressed).length
    const watchlist = markets.filter((m) => typeof m.signalCandidate?.confidence === 'number' && m.signalCandidate.confidence >= suppressBelow && m.signalCandidate.confidence < 75 && !m.signalSuppressed).length
    const suppressed = markets.filter((m) => m.signalSuppressed).length
    const transitional = markets.filter((m) => m.regime === 'TRANSITIONAL').length
    return { scanned: markets.length, surfaced: signals.length, actionable, watchlist, suppressed, transitional }
  }, [markets, signals, suppressBelow])

  const sortedMarkets = useMemo(() => {
    const ranked = [...markets]
    if (sortBy === 'confidence') {
      ranked.sort((a, b) => (b.signalCandidate?.confidence ?? -1) - (a.signalCandidate?.confidence ?? -1))
    } else if (sortBy === 'token') {
      ranked.sort((a, b) => a.id.localeCompare(b.id))
    } else {
      ranked.sort((a, b) => scoreActionability(b) - scoreActionability(a))
    }
    return ranked
  }, [markets, sortBy])

  return html`
    <div className="page">
      <${Header} />
      <main className="container">
        <${SummaryBar} summary=${summary} lastUpdated=${lastUpdated} schedule=${snapshot?.schedule || '5 * * * *'} />
        <${HistoryCharts} history=${history} markets=${markets} />

        <section className="card">
          <div className="card-actions spread">
            <div>
              <div className="card-label mono">Trade Signals</div>
              <div className="muted">We scan each market hourly and surface high-confidence setups only (visibility threshold: ${suppressBelow}).</div>
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
                          <div className="signal-head">
                            <div className="signal-value">${signal.token} — ${signal.side}</div>
                            <span className=${`badge badge-${tierClass(signal.tier)}`}>${signal.tier.replaceAll('_', ' ')}</span>
                          </div>
                          <div className="muted">${strategyLabel(signal.strategy)} in ${friendlyRegime(signal.regime)} market state.</div>
                          <div className="muted mono">Confidence ${signal.confidence} • ${signal.confidence >= 75 ? 'Actionable now' : 'Watchlist setup'}</div>
                          <div className="muted mono">Entry ${formatPrice(signal.entry?.trigger_price)} • Stop ${formatPrice(signal.invalidation?.stop_loss)} • Target ${formatPrice(signal.targets?.tp1)}</div>
                          <div className="muted mono">Expires: ${formatTimestamp(signal.expires_at)}</div>
                        </div>
                      `
                    )}
                  </div>
                `
              : html`<p className="muted">No surfaced signals this scan cycle. Check market cards below for suppressed or transitional states.</p>`}
        </section>

        <section className="card card-controls">
          <div className="card-actions spread">
            <div>
              <div className="card-label mono">Market View Controls</div>
              <div className="muted">Sort markets to bring the most relevant opportunities to the top.</div>
            </div>
            <div className="controls-row">
              <label className="muted mono" for="sortBy">Sort by</label>
              <select id="sortBy" value=${sortBy} onChange=${(e) => setSortBy(e.target.value)}>
                <option value="actionability">Actionability</option>
                <option value="confidence">Confidence</option>
                <option value="token">Token</option>
              </select>
            </div>
          </div>
        </section>

        <section className="grid market-grid">
          ${sortedMarkets.map((market) => html`<${MarketCard} key=${market.id} market=${market} suppressBelow=${suppressBelow} />`)}
        </section>

        <${Glossary} />
      </main>
      <${Footer} />
    </div>
  `
}

function SummaryBar({ summary, lastUpdated, schedule }) {
  return html`<section className="summary-grid">
    <div className="summary-item"><span>Scanned</span><strong>${summary.scanned || 0}</strong></div>
    <div className="summary-item"><span>Actionable</span><strong>${summary.actionable || 0}</strong></div>
    <div className="summary-item"><span>Watchlist</span><strong>${summary.watchlist || 0}</strong></div>
    <div className="summary-item"><span>Suppressed</span><strong>${summary.suppressed || 0}</strong></div>
    <div className="summary-item"><span>Transitional</span><strong>${summary.transitional || 0}</strong></div>
    <div className="summary-item wide"><span>Updated</span><strong>${lastUpdated}</strong><small className="muted mono">Schedule ${schedule}</small></div>
  </section>`
}

function HistoryCharts({ history, markets }) {
  if (!history.length) {
    return html`<section className="card"><div className="card-label mono">Last 48h charts</div><p className="muted">History will populate after scheduled scans or manual refreshes.</p></section>`
  }
  const series = [
    { key: 'surfaced', label: 'Surfaced signals' },
    { key: 'actionable', label: 'Actionable' },
    { key: 'watchlist', label: 'Watchlist' },
    { key: 'suppressed', label: 'Suppressed' },
    { key: 'transitional', label: 'Transitional' },
  ]
  return html`<section className="card">
    <div className="card-actions spread">
      <div>
        <div className="card-label mono">Last 48h charts</div>
        <div className="muted">Hourly snapshots only. Older points are auto-pruned.</div>
      </div>
      <div className="muted mono">${history.length} points</div>
    </div>
    <div className="chart-grid">
      ${series.map((s) => html`<${MiniChart} key=${s.key} label=${s.label} points=${history.map((h) => ({ x: h.timestamp, y: h[s.key] ?? 0 }))} />`)}
    </div>
    <div className="card-label mono" style=${{ marginTop: '1rem' }}>Per-ticker signal timeline</div>
    <div className="muted">Shows when each tracked ticker had surfaced/actionable calls in the scan history.</div>
    <div className="chart-grid">
      ${markets.map((market) => {
        const points = history.map((h) => ({ x: h.timestamp, y: h.perToken?.[market.id]?.surfaced ?? 0 }))
        const actionablePoints = history.map((h) => ({ x: h.timestamp, y: h.perToken?.[market.id]?.actionable ?? 0 }))
        const lastSignal = [...history].reverse().find((h) => (h.perToken?.[market.id]?.surfaced ?? 0) > 0)
        return html`<${MiniChart} key=${market.id} label=${`${market.id} surfaced`} points=${points} secondaryPoints=${actionablePoints} note=${lastSignal ? `Last surfaced ${new Date(lastSignal.timestamp).toLocaleString()}` : 'No surfaced call in visible window'} />`
      })}
    </div>
  </section>`
}

function MiniChart({ label, points, secondaryPoints, note }) {
  const max = Math.max(1, ...points.map((p) => p.y))
  const last = points.at(-1)?.y ?? 0
  return html`<article className="mini-chart">
    <div className="mini-chart-head"><strong>${label}</strong><span className="mono">${last}</span></div>
    ${note ? html`<div className="muted mono">${note}</div>` : null}
    <div className="mini-bars">
      ${points.map((point) => html`<div className="mini-bar" title=${`${new Date(point.x).toLocaleString()} • ${point.y}`} style=${{ height: `${Math.max(6, (point.y / max) * 100)}%` }}></div>`)}
    </div>
    ${secondaryPoints ? html`<div className="mini-bars mini-bars-secondary">
      ${secondaryPoints.map((point) => html`<div className="mini-bar mini-bar-secondary" title=${`Actionable ${new Date(point.x).toLocaleString()} • ${point.y}`} style=${{ height: `${Math.max(6, point.y ? 100 : 6)}%` }}></div>`)}
    </div>` : null}
  </article>`
}

function Header() { return html`<header className="header"><div className="container header-inner"><div className="brand"><h1>Signal Engine Monitor</h1><span className="muted">Understand market state first, then review trade details.</span></div><div className="controls"><${ThemeToggle} /><${CompactToggle} /></div></div></header>` }

function Footer() { return html`<footer className="footer"><div className="container"><p className="muted">Legend available above. Signal logic unchanged; presentation is simplified for first-glance readability.</p></div></footer>` }

function MarketCard({ market, suppressBelow }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const candidateConfidence = market.signalCandidate?.confidence
  const candidateStatus = market.error ? 'Error' : market.signalCandidate ? market.signalSuppressed ? `Hidden (confidence below ${suppressBelow})` : 'Visible candidate' : 'No candidate this cycle'

  return html`<article className="card market-card">
    <div className="card-actions spread">
      <div>
        <div className="card-label mono">${market.id}</div>
        <div className="card-value">${friendlyRegime(market.regime || '—')}</div>
        <div className="muted">Signal status: <strong>${candidateStatus}</strong></div>
      </div>
      <div className="price mono">Confidence ${formatMetric(candidateConfidence)}</div>
    </div>

    ${market.error ? html`<p className="error mono">${market.error}</p>` : html`
      <div className="stats-grid">
        <div><strong>Strategy:</strong> ${strategyLabel(market.signalCandidate?.strategy)}</div>
        <div><strong>Side:</strong> ${market.signalCandidate?.side || '—'}</div>
        <div><strong>Suppressed:</strong> ${market.signalSuppressed ? 'Yes' : 'No'}</div>
      </div>
      <button className="button" onClick=${() => setDetailsOpen(!detailsOpen)}>${detailsOpen ? 'Hide technical details' : 'Show technical details'}</button>
      ${detailsOpen ? html`<div className="tech-details mono">
        <div>ADX 4h: <strong>${formatMetric(market.indicators?.adx4h)}</strong></div>
        <div>EMA200 slope 4h: <strong>${formatMetric(market.indicators?.ema200Slope4h)}</strong></div>
        <div>BBW 4h: <strong>${formatMetric(market.indicators?.bbw4h)}</strong></div>
        <div>BBW median 30: <strong>${formatMetric(market.indicators?.bbw4hMedian30)}</strong></div>
      </div>` : null}
    `}
  </article>`
}

function Glossary() { return html`<section className="card"><div className="card-label mono">How to read this dashboard</div><div className="glossary-grid"><div><strong>Trend Pullback (TFP):</strong> Pullback entry in a strong trend.</div><div><strong>Trend Breakout (TBO):</strong> Breakout from compression/range after volatility squeeze.</div><div><strong>Mean Reversion Extremes (MRE):</strong> Reversal setup from overextended moves.</div><div><strong>ADX:</strong> Trend strength indicator (higher = stronger trend).</div><div><strong>BBW:</strong> Bollinger Band Width; lower values imply compression/squeeze.</div><div><strong>EMA200 slope:</strong> Directional slope of the long-term trend baseline.</div></div></section>` }

function strategyLabel(code) { return STRATEGY_LABELS[code] || (code || 'No strategy') }
function friendlyRegime(regime) { if (regime === 'TRENDING') return 'Trending'; if (regime === 'SQUEEZE') return 'Squeeze'; if (regime === 'RANGING') return 'Ranging'; if (regime === 'TRANSITIONAL') return 'Transitional'; return regime }
function scoreActionability(market) { if (market.error) return -1; if (!market.signalCandidate) return 0; let score = market.signalCandidate.confidence || 0; if (market.signalSuppressed) score -= 30; if (market.regime === 'TRANSITIONAL') score -= 10; return score }
function tierClass(tier) { if (tier === 'HIGH_CONVICTION') return 'high'; if (tier === 'ACTIONABLE') return 'action'; if (tier === 'WATCHLIST') return 'watch'; return 'suppressed' }
function ThemeToggle() { const [theme, setTheme] = useState(() => { try { return localStorage.getItem('theme') || 'light' } catch { return 'light' } }); useEffect(() => { const root = document.documentElement; if (theme === 'dark') { root.classList.add('dark'); localStorage.setItem('theme', 'dark') } else { root.classList.remove('dark'); localStorage.setItem('theme', 'light') } }, [theme]); return html`<button className="button button-green" onClick=${() => setTheme(theme === 'light' ? 'dark' : 'light')}>Toggle Theme</button>` }
function CompactToggle() { const [dense, setDense] = useState(() => { try { return localStorage.getItem('dense') === '1' } catch { return false } }); useEffect(() => { const root = document.documentElement; if (dense) { root.classList.add('dense'); localStorage.setItem('dense', '1') } else { root.classList.remove('dense'); localStorage.removeItem('dense') } }, [dense]); return html`<button className="button button-orange" onClick=${() => setDense(!dense)}>Compact</button>` }
function formatMetric(value) { if (typeof value !== 'number' || Number.isNaN(value)) return '—'; return value.toLocaleString(undefined, { maximumFractionDigits: 2 }) }
function formatPrice(value) { if (typeof value !== 'number' || Number.isNaN(value)) return '—'; if (Math.abs(value) >= 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`; return `$${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}` }
function formatTimestamp(value) { if (!value) return '—'; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString() }

const rootElement = document.getElementById('app')
if (!rootElement) throw new Error('Root element #app not found')
createRoot(rootElement).render(html`<${App} />`)
