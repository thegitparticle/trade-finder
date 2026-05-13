const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info'
const SNAPSHOT_KV_KEY = 'signal-engine-snapshot-v1'
const SNAPSHOT_HISTORY_KV_KEY = 'signal-engine-history-v1'
const ACTIVE_SIGNAL_PREFIX = 'active-signal-v1'
const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000

const ENGINE_CONFIG = {
  universe: ['ETH', 'BTC', 'SOL', 'DOGE', 'PEPE', 'XRP'],
  timeframes: {
    base: '1h',
    context: '4h',
    htf: '1d',
  },
  lookbacks: {
    base_bars: 320,
    context_bars: 220,
    htf_bars: 140,
  },
  regime: {
    trending: {
      adx_min: 25,
      ema200_slope_min: 0.02,
    },
    squeeze: {
      adx_max: 20,
      bbw_pct_of_median: 0.7,
      min_squeeze_bars: 12,
    },
    ranging: {
      adx_max: 20,
      ema200_slope_max: 0.005,
    },
  },
  strategies: {
    tfp: {
      rsi_pullback_zone_low: 40,
      rsi_pullback_zone_high: 50,
      pullback_tolerance_atr: 0.5,
      sl_atr_multiplier: 1.8,
      tp1_r_multiple: 2,
    },
    tbo: {
      breakout_atr_buffer: 0.3,
      volume_spike_min: 1.8,
      rsi_long_threshold: 60,
      rsi_short_threshold: 40,
      retest_window_bars: 6,
      sl_buffer_atr: 0.5,
    },
    mre: {
      rsi_oversold: 30,
      rsi_overbought: 70,
      bb_std: 2,
      divergence_lookback: 15,
      volume_spike_min: 1.5,
      sl_atr_multiplier: 1,
    },
  },
  confidence: {
    suppress_below: 60,
    watchlist: 60,
    actionable: 75,
    high_conviction: 90,
  },
  signal: {
    expiry_bars: 3,
    stale_candle_minutes: 90,
  },
}

export default {
  async fetch(request, env) {
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
      existing.history = await getHistory(env)
      return existing
    }
  }

  return refreshAndPersistSnapshot(env)
}

async function refreshAndPersistSnapshot(env) {
  const now = Date.now()
  const scan = await runHourlyScan(env, now)

  const snapshot = {
    generatedAt: new Date(now).toISOString(),
    schedule: '5 * * * *',
    note: 'Multi-strategy signal engine (TFP/TBO/MRE) with regime routing and confidence scoring.',
    config: {
      universe: ENGINE_CONFIG.universe,
      confidence: ENGINE_CONFIG.confidence,
      suppressBelow: ENGINE_CONFIG.confidence.suppress_below,
    },
    scanMeta: {
      tokensScanned: scan.markets.length,
      surfacedSignals: scan.signals.length,
      transitionalCount: scan.markets.filter((m) => m.regime === 'TRANSITIONAL').length,
    },
    signals: scan.signals,
    markets: scan.markets,
  }

  if (env.MARKET_CACHE) {
    const history = await updateHistory(env, snapshot)
    snapshot.history = history
    await env.MARKET_CACHE.put(SNAPSHOT_KV_KEY, JSON.stringify(snapshot), {
      expirationTtl: 60 * 60 * 6,
    })
  }

  return snapshot
}

async function getHistory(env) {
  if (!env.MARKET_CACHE) return []
  const history = (await env.MARKET_CACHE.get(SNAPSHOT_HISTORY_KV_KEY, 'json')) || []
  const cutoff = Date.now() - HISTORY_WINDOW_MS
  return history.filter((entry) => entry.timestamp >= cutoff)
}

async function updateHistory(env, snapshot) {
  const now = Date.parse(snapshot.generatedAt)
  const cutoff = now - HISTORY_WINDOW_MS
  const existing = (await env.MARKET_CACHE.get(SNAPSHOT_HISTORY_KV_KEY, 'json')) || []
  const history = existing
    .filter((entry) => entry.timestamp >= cutoff)
    .concat({
      timestamp: now,
      scanned: snapshot.scanMeta.tokensScanned,
      surfaced: snapshot.scanMeta.surfacedSignals,
      transitional: snapshot.scanMeta.transitionalCount,
      actionable: snapshot.markets.filter((m) => typeof m.signalCandidate?.confidence === 'number' && m.signalCandidate.confidence >= ENGINE_CONFIG.confidence.actionable && !m.signalSuppressed).length,
      watchlist: snapshot.markets.filter((m) => typeof m.signalCandidate?.confidence === 'number' && m.signalCandidate.confidence >= ENGINE_CONFIG.confidence.watchlist && m.signalCandidate.confidence < ENGINE_CONFIG.confidence.actionable && !m.signalSuppressed).length,
      suppressed: snapshot.markets.filter((m) => m.signalSuppressed).length,
    })
  await env.MARKET_CACHE.put(SNAPSHOT_HISTORY_KV_KEY, JSON.stringify(history), {
    expirationTtl: 60 * 60 * 72,
  })
  return history
}

async function runHourlyScan(env, now) {
  const signals = []
  const markets = []

  for (const token of ENGINE_CONFIG.universe) {
    const market = {
      id: token,
      token,
      source: 'hyperliquid',
      regime: 'TRANSITIONAL',
      indicators: null,
      signalCandidate: null,
      signalSuppressed: false,
      error: null,
    }

    try {
      const candles1h = await fetchCandlesByBars(token, ENGINE_CONFIG.timeframes.base, ENGINE_CONFIG.lookbacks.base_bars, now)
      const candles4h = await fetchCandlesByBars(token, ENGINE_CONFIG.timeframes.context, ENGINE_CONFIG.lookbacks.context_bars, now)
      const candles1d = await fetchCandlesByBars(token, ENGINE_CONFIG.timeframes.htf, ENGINE_CONFIG.lookbacks.htf_bars, now)

      validateCandles(token, candles1h, candles4h, candles1d, now)

      const regimeContext = classifyRegime(candles4h)
      market.regime = regimeContext.regime
      market.indicators = {
        adx4h: round(regimeContext.adx4h, 2),
        ema200Slope4h: round(regimeContext.ema200Slope4h, 4),
        bbw4h: round(regimeContext.bbw4h, 4),
        bbw4hMedian30: round(regimeContext.bbwMedian30, 4),
      }

      if (market.regime === 'TRANSITIONAL') {
        markets.push(market)
        continue
      }

      const duplicateKey = `${ACTIVE_SIGNAL_PREFIX}:${token}:${market.regime}`
      const existingSignal = env.MARKET_CACHE ? await env.MARKET_CACHE.get(duplicateKey, 'json') : null
      if (existingSignal) {
        market.signalCandidate = { skipped: true, reason: 'Duplicate active signal in TTL window' }
        markets.push(market)
        continue
      }

      const candidate = evaluateStrategyForRegime(token, market.regime, candles1h, candles4h, candles1d)
      if (!candidate) {
        markets.push(market)
        continue
      }

      market.signalCandidate = {
        strategy: candidate.strategy,
        side: candidate.side,
        confidence: candidate.confidence,
      }

      if (candidate.confidence < ENGINE_CONFIG.confidence.suppress_below) {
        market.signalSuppressed = true
        markets.push(market)
        continue
      }

      const signal = buildSignal(token, market.regime, candidate, now)
      signals.push(signal)

      if (env.MARKET_CACHE) {
        const expiryMs = new Date(signal.expires_at).getTime() - now
        await env.MARKET_CACHE.put(duplicateKey, JSON.stringify(signal), {
          expirationTtl: Math.max(60, Math.floor(expiryMs / 1000)),
        })
      }

      markets.push(market)
    } catch (error) {
      market.error = error instanceof Error ? error.message : String(error)
      markets.push(market)
    }
  }

  return { signals, markets }
}

function evaluateStrategyForRegime(token, regime, candles1h, candles4h, candles1d) {
  if (regime === 'TRENDING') {
    return evaluateTFP(token, candles1h, candles4h, candles1d)
  }

  if (regime === 'SQUEEZE') {
    return evaluateTBO(token, candles1h, candles4h, candles1d)
  }

  if (regime === 'RANGING') {
    return evaluateMRE(token, candles1h, candles4h, candles1d)
  }

  return null
}

function classifyRegime(candles4h) {
  const closes = candles4h.map((c) => c.close)
  const highs = candles4h.map((c) => c.high)
  const lows = candles4h.map((c) => c.low)

  const ema200 = emaSeries(closes, 200)
  const adx = adxSeries(highs, lows, closes, 14)
  const bb = bollingerBands(closes, 20, 2)
  const bbw = bb.upper.map((u, i) => {
    const basis = bb.middle[i]
    if (!Number.isFinite(u) || !Number.isFinite(bb.lower[i]) || !Number.isFinite(basis) || basis === 0) {
      return NaN
    }
    return (u - bb.lower[i]) / basis
  })

  const adx4h = lastFinite(adx)
  const emaNow = lastFinite(ema200)
  const emaLookback = nthLastFinite(ema200, 21)
  const ema200Slope4h = emaLookback ? (emaNow - emaLookback) / emaLookback : 0
  const bbw4h = lastFinite(bbw)
  const bbwTail = bbw.filter(Number.isFinite).slice(-30)
  const bbwMedian30 = median(bbwTail)

  const trending = adx4h >= ENGINE_CONFIG.regime.trending.adx_min && Math.abs(ema200Slope4h) > ENGINE_CONFIG.regime.trending.ema200_slope_min
  const squeeze =
    adx4h < ENGINE_CONFIG.regime.squeeze.adx_max &&
    Number.isFinite(bbw4h) &&
    Number.isFinite(bbwMedian30) &&
    bbw4h < bbwMedian30 * ENGINE_CONFIG.regime.squeeze.bbw_pct_of_median
  const ranging = adx4h < ENGINE_CONFIG.regime.ranging.adx_max && Math.abs(ema200Slope4h) < ENGINE_CONFIG.regime.ranging.ema200_slope_max

  let regime = 'TRANSITIONAL'
  if (trending) {
    regime = 'TRENDING'
  } else if (squeeze) {
    regime = 'SQUEEZE'
  } else if (ranging) {
    regime = 'RANGING'
  }

  return { regime, adx4h, ema200Slope4h, bbw4h, bbwMedian30 }
}

function evaluateTFP(token, candles1h, candles4h, candles1d) {
  const closes1h = candles1h.map((c) => c.close)
  const highs1h = candles1h.map((c) => c.high)
  const lows1h = candles1h.map((c) => c.low)
  const volumes1h = candles1h.map((c) => c.volume)

  const closes4h = candles4h.map((c) => c.close)
  const highs4h = candles4h.map((c) => c.high)
  const lows4h = candles4h.map((c) => c.low)

  const ema21 = emaSeries(closes1h, 21)
  const ema50 = emaSeries(closes1h, 50)
  const atr1h = atrSeries(highs1h, lows1h, closes1h, 14)
  const rsi1h = rsiSeries(closes1h, 14)
  const adx4h = adxSeries(highs4h, lows4h, closes4h, 14)
  const dmi4h = dmiSeries(highs4h, lows4h, closes4h, 14)
  const rsi1d = rsiSeries(candles1d.map((c) => c.close), 14)

  const close = closes1h.at(-1)
  const ema21Now = ema21.at(-1)
  const ema50Now = ema50.at(-1)
  const atrNow = atr1h.at(-1)
  const rsiNow = rsi1h.at(-1)
  const adxNow = adx4h.at(-1)
  const plusDINow = dmi4h.plusDI.at(-1)
  const minusDINow = dmi4h.minusDI.at(-1)
  const ema2004h = emaSeries(closes4h, 200).at(-1)

  const pullbackTo21 = Math.abs(close - ema21Now) <= atrNow * ENGINE_CONFIG.strategies.tfp.pullback_tolerance_atr
  const pullbackTo50 = Math.abs(close - ema50Now) <= atrNow * ENGINE_CONFIG.strategies.tfp.pullback_tolerance_atr

  const candlesTail = candles1h.slice(-5)
  const candlePattern = detectReversalPattern(candlesTail)
  const volumeAvg20 = mean(volumes1h.slice(-20))
  const pullbackVol = mean(volumes1h.slice(-4))
  const volumeRatioPullback = volumeAvg20 ? pullbackVol / volumeAvg20 : 1

  const isLong = close > ema2004h && plusDINow > minusDINow
  const isShort = close < ema2004h && minusDINow > plusDINow
  if (!isLong && !isShort) {
    return null
  }

  const inRsiZone = isLong
    ? rsiNow >= ENGINE_CONFIG.strategies.tfp.rsi_pullback_zone_low && rsiNow <= ENGINE_CONFIG.strategies.tfp.rsi_pullback_zone_high
    : rsiNow >= 50 && rsiNow <= 60

  if (!(pullbackTo21 || pullbackTo50) || !inRsiZone || !candlePattern) {
    return null
  }

  const side = isLong ? 'LONG' : 'SHORT'
  const swing = isLong ? findRecentSwingLow(candles1h) : findRecentSwingHigh(candles1h)
  const stopLoss = isLong ? Math.min(swing ?? close - atrNow, close - atrNow * ENGINE_CONFIG.strategies.tfp.sl_atr_multiplier) : Math.max(swing ?? close + atrNow, close + atrNow * ENGINE_CONFIG.strategies.tfp.sl_atr_multiplier)
  const risk = Math.abs(close - stopLoss)
  if (risk <= 0) {
    return null
  }
  const tp1 = isLong ? close + risk * ENGINE_CONFIG.strategies.tfp.tp1_r_multiple : close - risk * ENGINE_CONFIG.strategies.tfp.tp1_r_multiple
  const tp2 = isLong ? close + risk * 3.5 : close - risk * 3.5

  const score = scoreTFP({
    adxNow,
    pullbackTo50,
    rsiNow,
    volumeRatioPullback,
    candlePattern,
    htfTrendAgrees: trendAgreement1d(candles1d, side),
    structureBounce: Boolean(swing),
    htfRsiExtreme: isHtfRsiExtreme(rsi1d.at(-1), side),
  })

  return {
    strategy: 'TFP',
    side,
    confidence: score.total,
    tier: confidenceTier(score.total),
    entry: {
      zone_low: round(Math.min(ema21Now, ema50Now), 6),
      zone_high: round(Math.max(ema21Now, ema50Now), 6),
      trigger_price: round(close, 6),
      entry_mode: 'MARKET_OR_LIMIT_AT_ZONE',
    },
    invalidation: {
      stop_loss: round(stopLoss, 6),
      stop_distance_pct: round((risk / close) * 100, 3),
      stop_distance_atr: round(risk / atrNow, 2),
    },
    targets: {
      tp1: round(tp1, 6),
      tp2: round(tp2, 6),
      trail_method: 'EMA21_1H',
    },
    risk_params: {
      suggested_leverage: score.total >= 85 ? 7 : 5,
      risk_reward_tp1: ENGINE_CONFIG.strategies.tfp.tp1_r_multiple,
      risk_reward_tp2: 3.5,
    },
    context: {
      adx_4h: round(adxNow, 2),
      rsi_1h: round(rsiNow, 2),
      atr_1h_pct: round((atrNow / close) * 100, 3),
      ema21_1h: round(ema21Now, 6),
      ema50_1h: round(ema50Now, 6),
      ema200_4h: round(ema2004h, 6),
      volume_ratio_pullback: round(volumeRatioPullback, 2),
      confirmation_candle: candlePattern,
      htf_alignment: trendAgreement1d(candles1d, side),
    },
    score_breakdown: score.breakdown,
  }
}

function evaluateTBO(token, candles1h, candles4h, candles1d) {
  const closes1h = candles1h.map((c) => c.close)
  const highs1h = candles1h.map((c) => c.high)
  const lows1h = candles1h.map((c) => c.low)
  const volumes1h = candles1h.map((c) => c.volume)
  const closes4h = candles4h.map((c) => c.close)

  const atr1h = atrSeries(highs1h, lows1h, closes1h, 14)
  const rsi1h = rsiSeries(closes1h, 14)
  const macd = macdSeries(closes1h)
  const bb4h = bollingerBands(closes4h, 20, 2)
  const bbw4h = bb4h.upper.map((u, i) => (bb4h.middle[i] ? (u - bb4h.lower[i]) / bb4h.middle[i] : NaN))

  const squeezeDuration = countTrailing((v) => Number.isFinite(v) && v < median(bbw4h.filter(Number.isFinite).slice(-30)) * ENGINE_CONFIG.regime.squeeze.bbw_pct_of_median, bbw4h)
  if (squeezeDuration < ENGINE_CONFIG.regime.squeeze.min_squeeze_bars) {
    return null
  }

  const rangeHigh = Math.max(...highs1h.slice(-20))
  const rangeLow = Math.min(...lows1h.slice(-20))
  const close = closes1h.at(-1)
  const atrNow = atr1h.at(-1)
  const breakoutUp = close > rangeHigh + atrNow * ENGINE_CONFIG.strategies.tbo.breakout_atr_buffer
  const breakoutDown = close < rangeLow - atrNow * ENGINE_CONFIG.strategies.tbo.breakout_atr_buffer
  if (!breakoutUp && !breakoutDown) {
    return null
  }

  const side = breakoutUp ? 'LONG' : 'SHORT'
  const volumeAvg20 = mean(volumes1h.slice(-20))
  const volRatio = volumeAvg20 ? volumes1h.at(-1) / volumeAvg20 : 0
  const rsiNow = rsi1h.at(-1)
  const rsiPass = side === 'LONG' ? rsiNow >= ENGINE_CONFIG.strategies.tbo.rsi_long_threshold : rsiNow <= ENGINE_CONFIG.strategies.tbo.rsi_short_threshold
  const macdHist = macd.histogram
  const macdLine = macd.macd
  const sigLine = macd.signal
  const macdExpanding = side === 'LONG' ? macdHist.at(-1) > macdHist.at(-2) : macdHist.at(-1) < macdHist.at(-2)
  const macdConfirm = side === 'LONG' ? macdLine.at(-1) > sigLine.at(-1) : macdLine.at(-1) < sigLine.at(-1)

  if (volRatio < ENGINE_CONFIG.strategies.tbo.volume_spike_min || !rsiPass || !macdExpanding || !macdConfirm) {
    return null
  }

  const brokenLevel = side === 'LONG' ? rangeHigh : rangeLow
  const stopLoss = side === 'LONG' ? brokenLevel - atrNow * ENGINE_CONFIG.strategies.tbo.sl_buffer_atr : brokenLevel + atrNow * ENGINE_CONFIG.strategies.tbo.sl_buffer_atr
  const risk = Math.abs(close - stopLoss)
  const tp1 = side === 'LONG' ? close + risk * 1.5 : close - risk * 1.5
  const tp2 = side === 'LONG' ? close + risk * 2.5 : close - risk * 2.5

  const score = scoreTBO({
    squeezeDuration,
    volRatio,
    breakoutCloseStrength: breakoutCloseStrength(candles1h.at(-1), side),
    macdJustCrossed: crossedOnLastBar(macdLine, sigLine, side),
    rangeTests: countRangeTests(candles1h.slice(-30), brokenLevel),
    htfOpposes: trendAgreement1d(candles1d, side) === false,
  })

  return {
    strategy: 'TBO',
    side,
    confidence: score.total,
    tier: confidenceTier(score.total),
    entry: {
      zone_low: round(brokenLevel, 6),
      zone_high: round(close, 6),
      trigger_price: round(close, 6),
      entry_mode: 'BREAKOUT_CLOSE_OR_RETEST',
      aggressive_entry: round(close, 6),
      conservative_retest_level: round(brokenLevel, 6),
      retest_window_bars: ENGINE_CONFIG.strategies.tbo.retest_window_bars,
    },
    invalidation: {
      stop_loss: round(stopLoss, 6),
      stop_distance_pct: round((risk / close) * 100, 3),
      stop_distance_atr: round(risk / atrNow, 2),
    },
    targets: {
      tp1: round(tp1, 6),
      tp2: round(tp2, 6),
      trail_method: 'RANGE_RETEST_OR_SWING_TRAIL',
    },
    risk_params: {
      suggested_leverage: 5,
      risk_reward_tp1: 1.5,
      risk_reward_tp2: 2.5,
    },
    context: {
      squeeze_duration_4h: squeezeDuration,
      volume_ratio_breakout: round(volRatio, 2),
      rsi_1h: round(rsiNow, 2),
      macd_hist: round(macdHist.at(-1), 5),
      range_high: round(rangeHigh, 6),
      range_low: round(rangeLow, 6),
      htf_alignment: trendAgreement1d(candles1d, side),
    },
    score_breakdown: score.breakdown,
  }
}

function evaluateMRE(token, candles1h, candles4h, candles1d) {
  const closes1h = candles1h.map((c) => c.close)
  const highs1h = candles1h.map((c) => c.high)
  const lows1h = candles1h.map((c) => c.low)
  const volumes1h = candles1h.map((c) => c.volume)

  const rsi1h = rsiSeries(closes1h, 14)
  const rsi4h = rsiSeries(candles4h.map((c) => c.close), 14)
  const atr1h = atrSeries(highs1h, lows1h, closes1h, 14)
  const bb = bollingerBands(closes1h, 20, ENGINE_CONFIG.strategies.mre.bb_std)
  const macd = macdSeries(closes1h)
  const adx4h = adxSeries(candles4h.map((c) => c.high), candles4h.map((c) => c.low), candles4h.map((c) => c.close), 14)

  const latest = candles1h.at(-1)
  const close = latest.close
  const lowerBand = bb.lower.at(-1)
  const upperBand = bb.upper.at(-1)
  const rsiNow = rsi1h.at(-1)
  const rsiPrev = rsi1h.at(-2)
  const atrNow = atr1h.at(-1)
  const volumeAvg20 = mean(volumes1h.slice(-20))
  const volRatio = volumeAvg20 ? latest.volume / volumeAvg20 : 0

  const taggedLowerAndClosedInside = latest.low <= lowerBand && close >= lowerBand
  const taggedUpperAndClosedInside = latest.high >= upperBand && close <= upperBand

  const bullishDiv = detectRsiDivergence(candles1h, rsi1h, 'BULLISH', ENGINE_CONFIG.strategies.mre.divergence_lookback)
  const bearishDiv = detectRsiDivergence(candles1h, rsi1h, 'BEARISH', ENGINE_CONFIG.strategies.mre.divergence_lookback)

  let side = null
  if (
    taggedLowerAndClosedInside &&
    rsiNow <= ENGINE_CONFIG.strategies.mre.rsi_oversold &&
    rsiNow > rsiPrev &&
    bullishDiv.detected &&
    volRatio >= ENGINE_CONFIG.strategies.mre.volume_spike_min
  ) {
    side = 'LONG'
  }
  if (
    taggedUpperAndClosedInside &&
    rsiNow >= ENGINE_CONFIG.strategies.mre.rsi_overbought &&
    rsiNow < rsiPrev &&
    bearishDiv.detected &&
    volRatio >= ENGINE_CONFIG.strategies.mre.volume_spike_min
  ) {
    side = 'SHORT'
  }

  if (!side) {
    return null
  }

  const pattern = detectReversalPattern(candles1h.slice(-5))
  if (!pattern) {
    return null
  }

  const stopLoss = side === 'LONG' ? latest.low - atrNow * ENGINE_CONFIG.strategies.mre.sl_atr_multiplier : latest.high + atrNow * ENGINE_CONFIG.strategies.mre.sl_atr_multiplier
  const risk = Math.abs(close - stopLoss)
  const mean20 = emaSeries(closes1h, 20).at(-1)
  const tp1 = mean20
  const tp2 = side === 'LONG' ? upperBand : lowerBand

  const score = scoreMRE({
    divergenceBars: (side === 'LONG' ? bullishDiv : bearishDiv).bars,
    volRatio,
    strongPattern: ['BULLISH_ENGULFING', 'BEARISH_ENGULFING', 'MORNING_STAR', 'EVENING_STAR'].includes(pattern),
    structuralBounce: Boolean(side === 'LONG' ? findRecentSwingLow(candles1h) : findRecentSwingHigh(candles1h)),
    htfRsiExtreme: side === 'LONG' ? rsi4h.at(-1) <= 35 : rsi4h.at(-1) >= 65,
    macdStillTrend: side === 'LONG' ? macd.histogram.at(-1) < macd.histogram.at(-2) : macd.histogram.at(-1) > macd.histogram.at(-2),
    adx4hRising: adx4h.at(-1) > adx4h.at(-2),
  })

  return {
    strategy: 'MRE',
    side,
    confidence: score.total,
    tier: confidenceTier(score.total),
    entry: {
      zone_low: round(Math.min(lowerBand, upperBand), 6),
      zone_high: round(Math.max(lowerBand, upperBand), 6),
      trigger_price: round(close, 6),
      entry_mode: 'REVERSAL_CONFIRMATION',
    },
    invalidation: {
      stop_loss: round(stopLoss, 6),
      stop_distance_pct: round((risk / close) * 100, 3),
      stop_distance_atr: round(risk / atrNow, 2),
    },
    targets: {
      tp1: round(tp1, 6),
      tp2: round(tp2, 6),
      trail_method: 'MEAN_REVERSION_TO_BB_OPPOSITE',
    },
    risk_params: {
      suggested_leverage: 3,
      risk_reward_tp1: round(Math.abs(tp1 - close) / risk, 2),
      risk_reward_tp2: round(Math.abs(tp2 - close) / risk, 2),
    },
    context: {
      rsi_1h: round(rsiNow, 2),
      rsi_4h: round(rsi4h.at(-1), 2),
      volume_ratio_extreme: round(volRatio, 2),
      divergence: side === 'LONG' ? bullishDiv : bearishDiv,
      confirmation_candle: pattern,
      bb_lower_1h: round(lowerBand, 6),
      bb_upper_1h: round(upperBand, 6),
    },
    score_breakdown: score.breakdown,
  }
}

function buildSignal(token, regime, candidate, nowMs) {
  const expiresAt = new Date(nowMs + ENGINE_CONFIG.signal.expiry_bars * 60 * 60 * 1000).toISOString()
  return {
    timestamp: new Date(nowMs).toISOString(),
    token,
    regime,
    strategy: candidate.strategy,
    side: candidate.side,
    confidence: candidate.confidence,
    tier: candidate.tier,
    entry: candidate.entry,
    invalidation: candidate.invalidation,
    targets: candidate.targets,
    risk_params: candidate.risk_params,
    context: candidate.context,
    score_breakdown: candidate.score_breakdown,
    expires_at: expiresAt,
  }
}

function confidenceTier(score) {
  if (score >= ENGINE_CONFIG.confidence.high_conviction) return 'HIGH_CONVICTION'
  if (score >= ENGINE_CONFIG.confidence.actionable) return 'ACTIONABLE'
  if (score >= ENGINE_CONFIG.confidence.watchlist) return 'WATCHLIST'
  return 'SUPPRESSED'
}

function scoreTFP(input) {
  const breakdown = {
    base: 50,
    adx_strength: input.adxNow >= 30 ? 10 : 0,
    pullback_depth: input.pullbackTo50 ? 5 : 0,
    rsi_zone: input.rsiNow >= 40 && input.rsiNow <= 45 ? 5 : 0,
    volume_clean: input.volumeRatioPullback < 0.7 ? 10 : 0,
    candle_confirmation: input.candlePattern.includes('ENGULFING') ? 10 : 0,
    htf_alignment: input.htfTrendAgrees ? 10 : 0,
    structure_level: input.structureBounce ? 10 : 0,
    htf_momentum_penalty: input.htfRsiExtreme ? -10 : 0,
  }
  const total = clamp(
    breakdown.base +
      breakdown.adx_strength +
      breakdown.pullback_depth +
      breakdown.rsi_zone +
      breakdown.volume_clean +
      breakdown.candle_confirmation +
      breakdown.htf_alignment +
      breakdown.structure_level +
      breakdown.htf_momentum_penalty,
    0,
    100
  )
  breakdown.total = total
  return { total, breakdown }
}

function scoreTBO(input) {
  const breakdown = {
    base: 50,
    squeeze_duration: input.squeezeDuration >= 24 ? 10 : 0,
    volume_expansion: input.volRatio >= 2.5 ? 10 : 0,
    breakout_close_strength: input.breakoutCloseStrength ? 10 : 0,
    macd_cross: input.macdJustCrossed ? 10 : 0,
    range_tests: input.rangeTests >= 3 ? 10 : 0,
    htf_opposition_penalty: input.htfOpposes ? -15 : 0,
  }
  const total = clamp(Object.values(breakdown).reduce((a, b) => a + b, 0), 0, 100)
  breakdown.total = total
  return { total, breakdown }
}

function scoreMRE(input) {
  const breakdown = {
    base: 50,
    divergence_quality: input.divergenceBars >= 10 ? 10 : 0,
    volume_capitulation: input.volRatio >= 2.5 ? 10 : 0,
    reversal_pattern: input.strongPattern ? 10 : 0,
    structural_level: input.structuralBounce ? 15 : 0,
    htf_rsi_confluence: input.htfRsiExtreme ? 10 : 0,
    macd_penalty: input.macdStillTrend ? -10 : 0,
    adx_rising_penalty: input.adx4hRising ? -15 : 0,
  }
  const total = clamp(Object.values(breakdown).reduce((a, b) => a + b, 0), 0, 100)
  breakdown.total = total
  return { total, breakdown }
}

function validateCandles(token, candles1h, candles4h, candles1d, now) {
  if (candles4h.length < 200) {
    throw new Error(`${token}: insufficient 4h bars (${candles4h.length}/200)`)
  }

  const latest1h = candles1h.at(-1)
  if (!latest1h?.startTime || now - latest1h.startTime > ENGINE_CONFIG.signal.stale_candle_minutes * 60 * 1000) {
    throw new Error(`${token}: stale 1h candles`) 
  }

  const allCandles = [...candles1h, ...candles4h, ...candles1d]
  if (allCandles.some((c) => !Number.isFinite(c.volume) || c.volume <= 0)) {
    throw new Error(`${token}: volume gaps or zero-volume candles detected`)
  }
}

async function fetchCandlesByBars(coin, interval, lookbackBars, now) {
  const intervalMs = intervalToMs(interval)
  const startTime = now - intervalMs * lookbackBars
  return fetchCandles(coin, interval, startTime, now)
}

async function fetchCandles(coin, interval, startTime, endTime) {
  const response = await fetch(HYPERLIQUID_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime },
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

function rsiSeries(closes, period = 14) {
  if (closes.length <= period) return []
  const gains = []
  const losses = []
  for (let i = 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1]
    gains.push(Math.max(delta, 0))
    losses.push(Math.max(-delta, 0))
  }

  let avgGain = mean(gains.slice(0, period))
  let avgLoss = mean(losses.slice(0, period))
  const result = Array(period).fill(NaN)
  result.push(singleRsi(avgGain, avgLoss))

  for (let i = period; i < gains.length; i += 1) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period
    result.push(singleRsi(avgGain, avgLoss))
  }

  return result
}

function emaSeries(values, period) {
  const k = 2 / (period + 1)
  const result = []
  let ema = NaN

  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]
    if (i < period - 1) {
      result.push(NaN)
      continue
    }
    if (i === period - 1) {
      ema = mean(values.slice(0, period))
      result.push(ema)
      continue
    }
    ema = v * k + ema * (1 - k)
    result.push(ema)
  }

  return result
}

function atrSeries(highs, lows, closes, period = 14) {
  const tr = [NaN]
  for (let i = 1; i < highs.length; i += 1) {
    const highLow = highs[i] - lows[i]
    const highClose = Math.abs(highs[i] - closes[i - 1])
    const lowClose = Math.abs(lows[i] - closes[i - 1])
    tr.push(Math.max(highLow, highClose, lowClose))
  }
  return emaSeries(tr.map((v) => (Number.isFinite(v) ? v : 0)), period)
}

function dmiSeries(highs, lows, closes, period = 14) {
  const plusDM = [NaN]
  const minusDM = [NaN]
  const tr = [NaN]

  for (let i = 1; i < highs.length; i += 1) {
    const upMove = highs[i] - highs[i - 1]
    const downMove = lows[i - 1] - lows[i]
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])))
  }

  const smPlus = emaSeries(plusDM.map((v) => (Number.isFinite(v) ? v : 0)), period)
  const smMinus = emaSeries(minusDM.map((v) => (Number.isFinite(v) ? v : 0)), period)
  const smTr = emaSeries(tr.map((v) => (Number.isFinite(v) ? v : 0)), period)

  const plusDI = smPlus.map((v, i) => (smTr[i] ? (100 * v) / smTr[i] : NaN))
  const minusDI = smMinus.map((v, i) => (smTr[i] ? (100 * v) / smTr[i] : NaN))

  return { plusDI, minusDI }
}

function adxSeries(highs, lows, closes, period = 14) {
  const dmi = dmiSeries(highs, lows, closes, period)
  const dx = dmi.plusDI.map((v, i) => {
    const p = dmi.plusDI[i]
    const m = dmi.minusDI[i]
    if (!Number.isFinite(p) || !Number.isFinite(m) || p + m === 0) return NaN
    return (100 * Math.abs(p - m)) / (p + m)
  })
  return emaSeries(dx.map((v) => (Number.isFinite(v) ? v : 0)), period)
}

function macdSeries(values, fast = 12, slow = 26, signal = 9) {
  const fastEma = emaSeries(values, fast)
  const slowEma = emaSeries(values, slow)
  const macd = values.map((_, i) => (Number.isFinite(fastEma[i]) && Number.isFinite(slowEma[i]) ? fastEma[i] - slowEma[i] : NaN))
  const signalLine = emaSeries(macd.map((v) => (Number.isFinite(v) ? v : 0)), signal)
  const histogram = macd.map((v, i) => (Number.isFinite(v) && Number.isFinite(signalLine[i]) ? v - signalLine[i] : NaN))
  return { macd, signal: signalLine, histogram }
}

function bollingerBands(values, period = 20, stdMultiplier = 2) {
  const middle = smaSeries(values, period)
  const upper = []
  const lower = []

  for (let i = 0; i < values.length; i += 1) {
    if (i < period - 1 || !Number.isFinite(middle[i])) {
      upper.push(NaN)
      lower.push(NaN)
      continue
    }
    const slice = values.slice(i - period + 1, i + 1)
    const dev = standardDeviation(slice)
    upper.push(middle[i] + dev * stdMultiplier)
    lower.push(middle[i] - dev * stdMultiplier)
  }

  return { middle, upper, lower }
}

function smaSeries(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return NaN
    return mean(values.slice(i - period + 1, i + 1))
  })
}

function detectRsiDivergence(candles, rsi, mode, lookback = 15) {
  const bars = candles.slice(-lookback)
  const rsiBars = rsi.slice(-lookback)
  if (bars.length < 6 || rsiBars.length < 6) return { detected: false, bars: 0 }

  const pivots = []
  for (let i = 2; i < bars.length - 2; i += 1) {
    const current = bars[i]
    if (mode === 'BULLISH') {
      if (current.low <= bars[i - 1].low && current.low <= bars[i + 1].low) {
        pivots.push({ i, price: current.low, rsi: rsiBars[i] })
      }
    } else if (current.high >= bars[i - 1].high && current.high >= bars[i + 1].high) {
      pivots.push({ i, price: current.high, rsi: rsiBars[i] })
    }
  }

  if (pivots.length < 2) return { detected: false, bars: 0 }
  const a = pivots[pivots.length - 2]
  const b = pivots[pivots.length - 1]

  if (mode === 'BULLISH') {
    return { detected: b.price < a.price && b.rsi > a.rsi, bars: b.i - a.i }
  }
  return { detected: b.price > a.price && b.rsi < a.rsi, bars: b.i - a.i }
}

function detectReversalPattern(candles) {
  if (candles.length < 2) return null
  const last = candles.at(-1)
  const prev = candles.at(-2)

  const lastBull = last.close > last.open
  const lastBear = last.close < last.open
  const prevBull = prev.close > prev.open
  const prevBear = prev.close < prev.open

  const body = Math.abs(last.close - last.open)
  const lowerWick = Math.min(last.close, last.open) - last.low
  const upperWick = last.high - Math.max(last.close, last.open)

  if (lastBull && prevBear && last.close > prev.open && last.open < prev.close) return 'BULLISH_ENGULFING'
  if (lastBear && prevBull && last.open > prev.close && last.close < prev.open) return 'BEARISH_ENGULFING'
  if (lastBull && lowerWick > body * 1.8 && upperWick < body) return 'HAMMER'
  if (lastBear && upperWick > body * 1.8 && lowerWick < body) return 'SHOOTING_STAR'

  if (candles.length >= 3) {
    const a = candles.at(-3)
    if (a.close < a.open && prev.close < prev.open && last.close > last.open && last.close > (a.open + a.close) / 2) {
      return 'MORNING_STAR'
    }
    if (a.close > a.open && prev.close > prev.open && last.close < last.open && last.close < (a.open + a.close) / 2) {
      return 'EVENING_STAR'
    }
  }

  return null
}

function findRecentSwingLow(candles) {
  for (let i = candles.length - 3; i >= 2; i -= 1) {
    const c = candles[i]
    if (c.low < candles[i - 1].low && c.low < candles[i - 2].low && c.low < candles[i + 1].low && c.low < candles[i + 2].low) {
      return c.low
    }
  }
  return null
}

function findRecentSwingHigh(candles) {
  for (let i = candles.length - 3; i >= 2; i -= 1) {
    const c = candles[i]
    if (c.high > candles[i - 1].high && c.high > candles[i - 2].high && c.high > candles[i + 1].high && c.high > candles[i + 2].high) {
      return c.high
    }
  }
  return null
}

function trendAgreement1d(candles1d, side) {
  const closes = candles1d.map((c) => c.close)
  const ema50 = emaSeries(closes, 50).at(-1)
  const close = closes.at(-1)
  if (!Number.isFinite(ema50) || !Number.isFinite(close)) return null
  return side === 'LONG' ? close >= ema50 : close <= ema50
}

function isHtfRsiExtreme(rsi, side) {
  if (!Number.isFinite(rsi)) return false
  return side === 'LONG' ? rsi >= 75 : rsi <= 25
}

function breakoutCloseStrength(candle, side) {
  const range = candle.high - candle.low
  if (!range) return false
  const closePos = (candle.close - candle.low) / range
  return side === 'LONG' ? closePos >= 0.8 : closePos <= 0.2
}

function crossedOnLastBar(a, b, side) {
  if (a.length < 2 || b.length < 2) return false
  if (side === 'LONG') {
    return a.at(-2) <= b.at(-2) && a.at(-1) > b.at(-1)
  }
  return a.at(-2) >= b.at(-2) && a.at(-1) < b.at(-1)
}

function countRangeTests(candles, level) {
  return candles.reduce((count, c) => (Math.abs(c.high - level) / level < 0.003 || Math.abs(c.low - level) / level < 0.003 ? count + 1 : count), 0)
}

function countTrailing(predicate, values) {
  let count = 0
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (!predicate(values[i])) break
    count += 1
  }
  return count
}

function singleRsi(avgGain, avgLoss) {
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function standardDeviation(values) {
  const avg = mean(values)
  const variance = mean(values.map((v) => (v - avg) ** 2))
  return Math.sqrt(variance)
}

function intervalToMs(interval) {
  if (interval === '1h') return 60 * 60 * 1000
  if (interval === '4h') return 4 * 60 * 60 * 1000
  if (interval === '1d') return 24 * 60 * 60 * 1000
  throw new Error(`Unsupported interval ${interval}`)
}

function lastFinite(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(values[i])) return values[i]
  }
  return NaN
}

function nthLastFinite(values, n) {
  let count = 0
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (!Number.isFinite(values[i])) continue
    count += 1
    if (count === n) return values[i]
  }
  return NaN
}

function mean(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values) {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }
  return sorted[middle]
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
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
