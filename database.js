const Database = require('better-sqlite3');
const path = require('path');

const db = new Database('trading_data.db');
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS candles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    timeframe TEXT,
    timestamp TEXT,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume INTEGER,
    UNIQUE(symbol, timeframe, timestamp)
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    timestamp TEXT,
    price REAL,
    size INTEGER,
    side TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_trades_symbol_ts ON trades(symbol, timestamp);

  CREATE TABLE IF NOT EXISTS paper_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    side TEXT,
    price REAL,
    quantity INTEGER,
    status TEXT,
    timestamp TEXT
  );

  CREATE TABLE IF NOT EXISTS strategy_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    algo_name TEXT,
    side TEXT,
    entry_price REAL,
    target1 REAL,
    target2 REAL,
    target REAL,
    stop REAL,
    status TEXT,
    reasons TEXT,
    timestamp TEXT
  );
  CREATE TABLE IF NOT EXISTS session_stats (
    symbol TEXT,
    date TEXT,
    vah REAL,
    val REAL,
    poc REAL,
    asia_high REAL,
    asia_low REAL,
    ib_high REAL,
    ib_low REAL,
    orb1_high REAL,
    orb1_low REAL,
    orb5_high REAL,
    orb5_low REAL,
    orb15_high REAL,
    orb15_low REAL,
    UNIQUE(symbol, date)
  );

  CREATE INDEX IF NOT EXISTS idx_candles_symbol_tf_ts ON candles(symbol, timeframe, timestamp);
  CREATE INDEX IF NOT EXISTS idx_signals_symbol_ts ON strategy_signals(symbol, timestamp);
  CREATE INDEX IF NOT EXISTS idx_session_symbol_date ON session_stats(symbol, date);
`);

const insertCandle = db.prepare(`
  INSERT OR REPLACE INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertTrade = db.prepare(`
  INSERT INTO trades (symbol, timestamp, price, size, side)
  VALUES (?, ?, ?, ?, ?)
`);

const insertSignal = db.prepare(`
  INSERT INTO strategy_signals (symbol, algo_name, side, entry_price, target1, target2, target, stop, status, reasons, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
`);

const updateSignalStatus = db.prepare(`
  UPDATE strategy_signals SET status = ? WHERE id = ?
`);

function getPriorDayLevels(symbol) {
  const today = new Date().toISOString().split('T')[0];
  
  // Try to get from session_stats first (richer data)
  const stats = db.prepare(`
    SELECT * FROM session_stats 
    WHERE symbol = ? AND date < ?
    ORDER BY date DESC LIMIT 1
  `).get(symbol, today);

  if (stats) return stats;

  // Fallback to basic candle data
  const row = db.prepare(`
    SELECT high, low 
    FROM candles 
    WHERE symbol = ? AND timeframe = '1d' AND timestamp < ?
    ORDER BY timestamp DESC LIMIT 1
  `).get(symbol, today);
  return row || { high: null, low: null, vah: null, val: null, poc: null };
}

function saveSessionStats(stats) {
  const upsert = db.prepare(`
    INSERT INTO session_stats (
      symbol, date, vah, val, poc, asia_high, asia_low, ib_high, ib_low,
      orb1_high, orb1_low, orb5_high, orb5_low, orb15_high, orb15_low
    )
    VALUES (
      @symbol, @date, @vah, @val, @poc, @asia_high, @asia_low, @ib_high, @ib_low,
      @orb1_high, @orb1_low, @orb5_high, @orb5_low, @orb15_high, @orb15_low
    )
    ON CONFLICT(symbol, date) DO UPDATE SET
      vah=excluded.vah, val=excluded.val, poc=excluded.poc,
      asia_high=excluded.asia_high, asia_low=excluded.asia_low,
      ib_high=excluded.ib_high, ib_low=excluded.ib_low,
      orb1_high=excluded.orb1_high, orb1_low=excluded.orb1_low,
      orb5_high=excluded.orb5_high, orb5_low=excluded.orb5_low,
      orb15_high=excluded.orb15_high, orb15_low=excluded.orb15_low
  `);
  upsert.run(stats);
}

function getPendingSignals(symbol) {
  return db.prepare(`SELECT * FROM strategy_signals WHERE symbol = ? AND status = 'PENDING'`).all(symbol);
}

function setSignalStatus(id, status) {
  updateSignalStatus.run(status, id);
}

function getAlgoStats(symbol) {
  // Returns WIN/LOSS counts per algo_name
  return db.prepare(`
    SELECT algo_name, status, COUNT(*) as count 
    FROM strategy_signals 
    WHERE symbol = ? AND status IN ('WIN', 'LOSS') 
    GROUP BY algo_name, status
  `).all(symbol);
}

function getAlgoStatsDetailed(symbol) {
  // Returns rich per-algo stats including EV, R/R, Kelly
  const rows = db.prepare(`
    SELECT
      algo_name,
      status,
      COUNT(*) as count,
      AVG(ABS(target - entry_price)) as avg_gain_pts,
      AVG(ABS(stop - entry_price)) as avg_loss_pts
    FROM strategy_signals
    WHERE symbol = ? AND status IN ('WIN', 'LOSS')
    GROUP BY algo_name, status
  `).all(symbol);

  const byAlgo = {};
  rows.forEach(r => {
    if (!byAlgo[r.algo_name]) byAlgo[r.algo_name] = {};
    byAlgo[r.algo_name][r.status] = r;
  });

  return Object.keys(byAlgo).map(algo => {
    const win  = byAlgo[algo]['WIN']  || { count: 0, avg_gain_pts: 0, avg_loss_pts: 0 };
    const loss = byAlgo[algo]['LOSS'] || { count: 0, avg_gain_pts: 0, avg_loss_pts: 0 };
    const total = win.count + loss.count;
    const winRate = total > 0 ? win.count / total : 0;
    const lossRate = 1 - winRate;
    const avgWin  = win.avg_gain_pts  || 0;
    const avgLoss = loss.avg_loss_pts || 1; // avoid div/0
    const rr = avgLoss > 0 ? avgWin / avgLoss : 0;
    // EV per trade in points
    const ev = (winRate * avgWin) - (lossRate * avgLoss);
    // Kelly fraction: f* = (b*p - q) / b  where b = R/R
    const kelly = rr > 0 ? Math.max(0, (rr * winRate - lossRate) / rr) : 0;
    return {
      algo_name: algo,
      wins: win.count,
      losses: loss.count,
      total,
      win_rate: winRate,
      avg_win_pts: avgWin,
      avg_loss_pts: avgLoss,
      rr: rr,
      ev: ev,
      kelly: kelly
    };
  }).sort((a, b) => b.ev - a.ev); // rank by EV
}

function getAllSignals(symbol, limit = 50) {
  return db.prepare(`
    SELECT * FROM strategy_signals
    WHERE symbol = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(symbol, limit);
}

function getDailyPnL(symbol) {
  const today = new Date().toISOString().split('T')[0];
  const rows = db.prepare(`
    SELECT algo_name, side, entry_price, target, stop, status
    FROM strategy_signals
    WHERE symbol = ? AND status IN ('WIN','LOSS') AND timestamp >= ?
  `).all(symbol, today);
  let pnl = 0;
  const MNQ_POINT_VALUE = 2; // $2 per point for MNQ
  rows.forEach(r => {
    if (r.status === 'WIN') pnl += Math.abs(r.target - r.entry_price) * MNQ_POINT_VALUE;
    else pnl -= Math.abs(r.stop - r.entry_price) * MNQ_POINT_VALUE;
  });
  return { pnl, trades: rows.length };
}

module.exports = {
  db,
  getAlgoStatsDetailed,
  getAllSignals,
  getDailyPnL,
  getPriorDayLevels,
  getPendingSignals,
  setSignalStatus,
  getAlgoStats,
  saveSessionStats,
  saveSignal: (sig) => {
    insertSignal.run(sig.symbol, sig.algo_name, sig.side, sig.entry_price, sig.target1, sig.target2, sig.target, sig.stop, JSON.stringify(sig.reasons), new Date().toISOString());
  },

  saveCandle: (candle) => {
    insertCandle.run(
      candle.symbol,
      candle.timeframe,
      candle.timestamp,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume
    );
  },
  saveTrade: (trade) => {
    insertTrade.run(
      trade.symbol,
      trade.timestamp,
      trade.price,
      trade.size,
      trade.side || 'unknown'
    );
  },
  savePaperOrder: (order) => {
    db.prepare(`
      INSERT INTO paper_orders (symbol, side, price, quantity, status, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(order.symbol, order.side, order.price, order.quantity, order.status, order.timestamp);
  },
  getPaperOrders: () => {
    return db.prepare(`SELECT * FROM paper_orders ORDER BY timestamp DESC LIMIT 50`).all();
  },
  cleanupOldData: (days = 7) => {
    const cutoff = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
    const tradesDel = db.prepare(`DELETE FROM trades WHERE timestamp < ?`).run(cutoff);
    const candlesDel = db.prepare(`DELETE FROM candles WHERE timestamp < ? AND timeframe NOT IN ('1h', '4h', '1d')`).run(cutoff);
    console.log(`[DB] Cleanup complete. Removed ${tradesDel.changes} old trades and ${candlesDel.changes} low-tf candles.`);
  }
};
