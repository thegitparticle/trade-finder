import React, { useEffect, useMemo, useState } from 'https://esm.sh/react@18.2.0'
import { createRoot } from 'https://esm.sh/react-dom@18.2.0/client'
import htm from 'https://esm.sh/htm@3.1.1'

const html = htm.bind(React.createElement)

function App() {
  const lastUpdated = useMemo(() => new Date().toISOString(), [])
  const buildRandom = useMemo(() => {
    return {
      value: Math.floor(Math.random() * 1000),
      generatedAt: new Date().toISOString(),
    }
  }, [])
  const stats = useMemo(
    () => ({
      totalUsers: 12345,
      activeUsers: 3210,
      revenue: 123456,
      growthRate: 2.4,
    }),
    []
  )

  return html`
    <div className="page">
      <div className="scanline" aria-hidden="true"></div>
      <${Header} />
      <main className="container">
        <div className="page-header">
          <p className="muted mono">Last updated: ${new Date(lastUpdated).toLocaleString()}</p>
        </div>
        <section className="card-row">
          <div className="card">
            <div className="card-label mono">Build-time value (static)</div>
            <div className="card-value">${buildRandom.value}</div>
            <div className="muted mono">${new Date(buildRandom.generatedAt).toLocaleString()}</div>
          </div>
          <${RuntimeRandom} />
        </section>
        <section className="grid">
          <${StatCard} label="Total Users" value=${stats.totalUsers.toLocaleString()} />
          <${StatCard} label="Active Users" value=${stats.activeUsers.toLocaleString()} />
          <${StatCard} label="Revenue" value=${`$${stats.revenue.toLocaleString()}`} />
          <${StatCard} label="Growth Rate" value=${`${stats.growthRate}%`} />
        </section>
        <section className="grid">
          <div className="card">Overview charts placeholder</div>
          <div className="card">Trend chart placeholder</div>
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
          <h1>Dashboard</h1>
          <span className="muted mono">Industrial • Dense • Small</span>
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
        <p className="muted mono">Built with Cloudflare Pages • Updated every hour</p>
      </div>
    </footer>
  `
}

function StatCard({ label, value }) {
  return html`
    <div className="card">
      <div className="card-label mono">${label}</div>
      <div className="card-value">${value}</div>
    </div>
  `
}

function RuntimeRandom() {
  const [value, setValue] = useState(null)
  const [generatedAt, setGeneratedAt] = useState(null)
  const [loading, setLoading] = useState(false)

  const fetchRuntime = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/random')
      if (!response.ok) {
        throw new Error('Failed to fetch runtime random')
      }
      const json = await response.json()
      setValue(json.value)
      setGeneratedAt(json.generatedAt)
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchRuntime()
  }, [])

  return html`
    <div className="card">
      <div className="card-label mono">Runtime value (client-side)</div>
      <div className="card-value">${loading ? '...' : value ?? '—'}</div>
      <div className="card-actions">
        <span className="muted mono">${generatedAt ? new Date(generatedAt).toLocaleString() : ''}</span>
        <button className="button button-orange" onClick=${fetchRuntime}>Refresh</button>
      </div>
    </div>
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

const rootElement = document.getElementById('app')

if (!rootElement) {
  throw new Error('Root element #app not found')
}

const root = createRoot(rootElement)
root.render(html`<${App} />`)
