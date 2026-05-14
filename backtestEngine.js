const { DateTime } = require('luxon');
const { db } = require('./database');
const { CONTRACT_ID } = require('./config');

const DEFAULT_POINT_VALUES = {
  MNQ: 2,
  MES: 5,
  M2K: 5,
  MYM: 0.5,
  MGC: 10,
  NQ: 20,
  ES: 50,
  RTY: 50,
  YM: 5,
  GC: 100
};

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function inferRootSymbol(symbol = '') {
  const match = String(symbol).match(/\.([A-Z0-9]+)\.[HMUZ]\d{2}$/) || String(symbol).match(/\/([A-Z0-9]+)/);
  return match ? match[1] : 'MNQ';
}

function inferPointValue(symbol) {
  return DEFAULT_POINT_VALUES[inferRootSymbol(symbol)] || 1;
}

function getBacktestSymbols(symbolParam) {
  if (symbolParam) {
    return String(symbolParam)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  const rows = db.prepare(`
    SELECT DISTINCT symbol
    FROM candles
    WHERE timeframe = '1m'
    ORDER BY symbol
  `).all();

  return rows.length ? rows.map(r => r.symbol) : [CONTRACT_ID];
}

function loadCandles(symbol, timeframe = '1m', limit = 50000) {
  return db.prepare(`
    SELECT timestamp, open, high, low, close, volume, delta
    FROM candles
    WHERE symbol = ? AND timeframe = ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(symbol, timeframe, limit).map(row => ({
    ...row,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume || 0),
    delta: Number(row.delta || 0)
  }));
}

function groupRthCandlesBySession(candles, zone = 'America/New_York') {
  const sessions = new Map();

  for (const candle of candles) {
    const dt = DateTime.fromISO(candle.timestamp, { zone: 'utc' }).setZone(zone);
    const isRth = (dt.hour === 9 && dt.minute >= 30) || (dt.hour >= 10 && dt.hour < 16);
    if (!isRth) continue;

    const date = dt.toFormat('yyyy-MM-dd');
    if (!sessions.has(date)) sessions.set(date, []);
    sessions.get(date).push({ ...candle, dt, date });
  }

  for (const sessionCandles of sessions.values()) {
    sessionCandles.sort((a, b) => a.dt.toMillis() - b.dt.toMillis());
  }

  return sessions;
}

function calculateEquityStats(trades, pointValue) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const returns = [];

  for (const trade of trades) {
    const pnl = trade.pnl_points * pointValue * trade.quantity;
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (pnl >= 0) grossProfit += pnl;
    else grossLoss += Math.abs(pnl);
    returns.push(pnl);
  }

  const avg = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (returns.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);

  return {
    pnl: equity,
    max_drawdown: maxDrawdown,
    profit_factor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe_like: stdDev > 0 ? avg / stdDev : 0
  };
}

function summarizeTrades({ strategy, symbol, trades, pointValue, quantity, params }) {
  const wins = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  const scratches = trades.filter(t => t.outcome === 'SCRATCH');
  const total = trades.length;
  const avgWinPts = wins.length ? wins.reduce((sum, t) => sum + t.pnl_points, 0) / wins.length : 0;
  const avgLossPts = losses.length ? Math.abs(losses.reduce((sum, t) => sum + t.pnl_points, 0) / losses.length) : 0;
  const winRate = total ? wins.length / total : 0;
  const lossRate = total ? losses.length / total : 0;
  const rr = avgLossPts > 0 ? avgWinPts / avgLossPts : 0;
  const kelly = rr > 0 ? Math.max(0, Math.min(1, ((rr * winRate) - lossRate) / rr)) : 0;
  const evPoints = total ? trades.reduce((sum, t) => sum + t.pnl_points, 0) / total : 0;
  const equity = calculateEquityStats(trades, pointValue);

  return {
    strategy,
    symbol,
    point_value: pointValue,
    quantity,
    params,
    trades: total,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,
    win_rate: winRate,
    avg_win_pts: avgWinPts,
    avg_loss_pts: avgLossPts,
    rr,
    ev_points: evPoints,
    pnl: equity.pnl,
    max_drawdown: equity.max_drawdown,
    profit_factor: Number.isFinite(equity.profit_factor) ? equity.profit_factor : null,
    sharpe_like: equity.sharpe_like,
    kelly,
    sample_trades: trades.slice(-10)
  };
}

function runOrbBacktest(symbol, options = {}) {
  const orMinutes = clampInteger(options.orMinutes, 15, 1, 60);
  const targetPoints = clampNumber(options.targetPoints, 20, 0.25, 1000);
  const stopPoints = clampNumber(options.stopPoints, 10, 0.25, 1000);
  const quantity = clampInteger(options.quantity, 1, 1, 100);
  const limit = clampInteger(options.limit, 50000, 100, 250000);
  const pointValue = clampNumber(options.pointValue, inferPointValue(symbol), 0.01, 1000);
  const candles = options.candles || loadCandles(symbol, '1m', limit);
  const sessions = groupRthCandlesBySession(candles, options.zone || 'America/New_York');
  const trades = [];

  for (const [date, sessionCandles] of sessions.entries()) {
    const openingRange = sessionCandles.filter(c => c.dt.hour === 9 && c.dt.minute >= 30 && c.dt < c.dt.set({ hour: 9, minute: 30 }).plus({ minutes: orMinutes }));
    if (openingRange.length < Math.min(orMinutes, 3)) continue;

    const rangeEnd = openingRange[openingRange.length - 1].dt;
    const high = Math.max(...openingRange.map(c => c.high));
    const low = Math.min(...openingRange.map(c => c.low));
    let active = null;

    for (const candle of sessionCandles) {
      if (candle.dt <= rangeEnd) continue;

      if (!active) {
        const brokeHigh = candle.high > high;
        const brokeLow = candle.low < low;
        if (brokeHigh && brokeLow) continue;
        if (brokeHigh) {
          active = {
            side: 'BUY',
            entry_time: candle.timestamp,
            entry: high,
            stop: high - stopPoints,
            target: high + targetPoints
          };
        } else if (brokeLow) {
          active = {
            side: 'SELL',
            entry_time: candle.timestamp,
            entry: low,
            stop: low + stopPoints,
            target: low - targetPoints
          };
        }
      }

      if (!active) continue;

      if (active.side === 'BUY') {
        // Conservative same-bar handling: stop is evaluated before target.
        if (candle.low <= active.stop) {
          trades.push({ date, ...active, exit_time: candle.timestamp, exit: active.stop, outcome: 'LOSS', pnl_points: -stopPoints, quantity });
          break;
        }
        if (candle.high >= active.target) {
          trades.push({ date, ...active, exit_time: candle.timestamp, exit: active.target, outcome: 'WIN', pnl_points: targetPoints, quantity });
          break;
        }
      } else {
        if (candle.high >= active.stop) {
          trades.push({ date, ...active, exit_time: candle.timestamp, exit: active.stop, outcome: 'LOSS', pnl_points: -stopPoints, quantity });
          break;
        }
        if (candle.low <= active.target) {
          trades.push({ date, ...active, exit_time: candle.timestamp, exit: active.target, outcome: 'WIN', pnl_points: targetPoints, quantity });
          break;
        }
      }
    }

    if (active && !trades.some(t => t.date === date)) {
      const close = sessionCandles[sessionCandles.length - 1];
      const pnlPoints = active.side === 'BUY' ? close.close - active.entry : active.entry - close.close;
      trades.push({
        date,
        ...active,
        exit_time: close.timestamp,
        exit: close.close,
        outcome: pnlPoints > 0 ? 'WIN' : (pnlPoints < 0 ? 'LOSS' : 'SCRATCH'),
        pnl_points: pnlPoints,
        quantity
      });
    }
  }

  return summarizeTrades({
    strategy: `ORB_${orMinutes}`,
    symbol,
    trades,
    pointValue,
    quantity,
    params: { or_minutes: orMinutes, target_points: targetPoints, stop_points: stopPoints }
  });
}

function isEnabled(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function buildBacktestMatrix(options = {}) {
  if (!isEnabled(options.sweep)) return [options];

  const orMinutes = String(options.orMinutes || options.or || '1,5,15')
    .split(',')
    .map(v => clampInteger(v, 15, 1, 60));
  const targets = String(options.targetPoints || options.target || '10,20,30')
    .split(',')
    .map(v => clampNumber(v, 20, 0.25, 1000));
  const stops = String(options.stopPoints || options.stop || '10,15')
    .split(',')
    .map(v => clampNumber(v, 10, 0.25, 1000));

  const matrix = [];
  for (const orMinute of [...new Set(orMinutes)]) {
    for (const target of [...new Set(targets)]) {
      for (const stop of [...new Set(stops)]) {
        matrix.push({ ...options, sweep: false, orMinutes: orMinute, targetPoints: target, stopPoints: stop });
      }
    }
  }
  return matrix.slice(0, 100);
}

function runBacktest(options = {}) {
  const symbols = getBacktestSymbols(options.symbols || options.symbol);
  const matrix = buildBacktestMatrix(options);
  const results = [];

  for (const symbol of symbols) {
    const candles = loadCandles(symbol, '1m', clampInteger(options.limit, 50000, 100, 250000));
    for (const params of matrix) {
      results.push(runOrbBacktest(symbol, { ...params, candles }));
    }
  }

  return {
    generated_at: new Date().toISOString(),
    strategy: 'ORB',
    sweep: isEnabled(options.sweep),
    results: results.sort((a, b) => (b.ev_points - a.ev_points) || (b.win_rate - a.win_rate) || (b.trades - a.trades))
  };
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, value = true] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }));
  const report = runBacktest({
    symbols: args.symbols || args.symbol,
    orMinutes: args.or || args.orMinutes,
    targetPoints: args.target,
    stopPoints: args.stop,
    quantity: args.quantity,
    limit: args.limit,
    sweep: args.sweep
  });
  console.log(JSON.stringify(report, null, 2));
}

module.exports = {
  inferPointValue,
  loadCandles,
  groupRthCandlesBySession,
  runOrbBacktest,
  buildBacktestMatrix,
  runBacktest
};
