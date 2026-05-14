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
