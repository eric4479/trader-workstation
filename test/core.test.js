const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const tmpDir = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'trader-db-'));
process.env.TRADING_DB_PATH = path.join(tmpDir, 'trading_data.db');
process.env.CONTRACT_ID = 'CON.F.US.MNQ.M26';

const database = require('../database');
const { getSignals } = require('../strategyEngine');
const schwab = require('../schwabConnector');
const { inferPointValue, runOrbBacktest, runBacktest } = require('../backtestEngine');
const { findConflictMarkers } = require('../scripts/checkConflicts');


test('repository has no unresolved merge conflict markers', () => {
  const conflicts = findConflictMarkers(path.resolve(__dirname, '..'));
  assert.deepEqual(conflicts, []);
});

test('database uses an explicit, absolute path and creates core tables', () => {
  assert.equal(database.DB_PATH, process.env.TRADING_DB_PATH);
  assert.equal(path.isAbsolute(database.DB_PATH), true);

  const tables = database.db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('candles', 'strategy_signals', 'paper_orders', 'session_stats')
    ORDER BY name
  `).all().map(row => row.name);

  assert.deepEqual(tables, ['candles', 'paper_orders', 'session_stats', 'strategy_signals']);
});

test('paper orders persist as open bracket orders with stop and target', () => {
  const result = database.savePaperOrder({
    symbol: process.env.CONTRACT_ID,
    side: 'BUY',
    price: 100,
    quantity: 1,
    signal_id: null,
    stop_loss: 95,
    take_profit: 110
  });

  assert.equal(result.changes, 1);
  const openOrders = database.getOpenPaperOrders(process.env.CONTRACT_ID);
  assert.equal(openOrders.length, 1);
  assert.equal(openOrders[0].status, 'OPEN');
  assert.equal(openOrders[0].stop_loss, 95);
  assert.equal(openOrders[0].take_profit, 110);
});

test('strategy engine handles no historical bars without throwing', async () => {
  const result = await getSignals(100, [], {}, 100, {}, {}, {});
  assert.deepEqual(result.signals, []);
  assert.equal(result.structure, null);
  assert.equal(result.indicators, null);
});

test('strategy engine returns ranked signal payload shape with synthetic bars', async () => {
  const bars = Array.from({ length: 250 }, (_, i) => ({
    open: 100 + i * 0.1,
    high: 101 + i * 0.1,
    low: 99 + i * 0.1,
    close: 100 + i * 0.1,
    volume: 100 + i,
    timestamp: new Date(Date.UTC(2026, 0, 1, 14, 30 + i)).toISOString(),
    delta: i % 2 === 0 ? 10 : -8
  }));

  const result = await getSignals(125, bars, {}, 120, {}, {
    orb1: {}, orb5: {}, orb15: {}, asia: {}, ib: {}
  }, {});

  assert.ok(Array.isArray(result.signals));
  assert.equal(typeof result.confluence.score, 'number');
  assert.ok(result.structure);
  assert.ok(result.indicators);
});

test('Schwab optional stream reports missing credentials without retry loop', async () => {
  delete process.env.SCHWAB_REFRESH_TOKEN;
  delete process.env.SCHWAB_APP_KEY;
  assert.equal(schwab.hasCredentials(), false);
  const token = await schwab.authenticate();
  assert.equal(token, null);
});


test('ORB backtester ranks a completed breakout with futures P&L metrics', () => {
  const symbol = 'CON.F.US.MNQ.M26';
  const start = Date.UTC(2026, 0, 2, 14, 30);
  for (let i = 0; i < 25; i += 1) {
    const timestamp = new Date(start + i * 60000).toISOString();
    const candle = i < 15
      ? { open: 100, high: 101, low: 99, close: 100, volume: 100 }
      : i === 16
        ? { open: 101, high: 102, low: 100.5, close: 101.5, volume: 200 }
        : i === 17
          ? { open: 101.5, high: 122, low: 101.25, close: 121.5, volume: 300 }
          : { open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 };
    database.saveCandle({ symbol, timeframe: '1m', timestamp, delta: 0, ...candle });
  }

  const report = runOrbBacktest(symbol, { orMinutes: 15, targetPoints: 20, stopPoints: 10, quantity: 1 });
  assert.equal(report.trades, 1);
  assert.equal(report.wins, 1);
  assert.equal(report.pnl, 40);
  assert.equal(report.point_value, inferPointValue(symbol));
  assert.equal(report.sample_trades[0].outcome, 'WIN');
});


test('backtest sweep ranks multiple ORB parameter combinations', () => {
  const report = runBacktest({ symbols: 'CON.F.US.MNQ.M26', sweep: true, orMinutes: '5,15', targetPoints: '10,20', stopPoints: '10', limit: 1000 });
  assert.equal(report.sweep, true);
  assert.equal(report.results.length, 4);
  for (let i = 1; i < report.results.length; i += 1) {
    assert.ok(report.results[i - 1].ev_points >= report.results[i].ev_points);
  }
});
