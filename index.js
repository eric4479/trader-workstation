const { getToken, hasTopstepCredentials } = require('./auth');
const { startStream } = require('./stream');
const { startDashboard } = require('./dashboard');
const { getSignals } = require('./strategyEngine');
const { getRecentBars } = require('./candleEngine');
const {
  getPriorDayLevels,
  saveSignal,
  getPendingSignals,
  setSignalStatus,
  getAlgoStats,
  getAlgoStatsDetailed,
  getDailyPnL,
  cleanupOldData,
  saveSessionStats,
  savePaperOrder,
  updatePaperOrder,
  getOpenPaperOrders
} = require('./database');
const { CONTRACT_ID, DATA_PROVIDER, SCHWAB_ENABLED } = require('./config');
const { getMarketInternals, getEconomicCalendar } = require('./marketInternals');
const schwab = require('./schwabConnector');

const runtimeStatus = {
  mode: DATA_PROVIDER,
  topstepx: { enabled: hasTopstepCredentials(), connected: false, lastTickAt: null, error: null },
  schwab: { enabled: SCHWAB_ENABLED && schwab.hasCredentials(), connected: false, lastTickAt: null, error: null },
  startedAt: new Date().toISOString()
};

let globalInternals = {};
let highImpactNews = [];

function normalizeContextSymbol(symbol) {
  const map = {
    '$VIX.X': 'VIX',
    '/ES': 'ES',
    '/NQ': 'NQ',
    '/MNQ': 'MNQ',
    '/MES': 'MES',
    UUP: 'DXY'
  };
  return map[symbol] || String(symbol || '').replace(/^[/$]/, '');
}

function mergeMarketContext(symbol, data = {}) {
  const key = normalizeContextSymbol(symbol);
  if (!key) return;
  if (!globalInternals[key]) globalInternals[key] = {};
  const s = globalInternals[key];
  if (data.last !== undefined) s.price = data.last;
  if (data.mark !== undefined && s.price === undefined) s.price = data.mark;
  if (data.bid !== undefined) s.bid = data.bid;
  if (data.ask !== undefined) s.ask = data.ask;
  if (data.high !== undefined) s.high = data.high;
  if (data.low !== undefined) s.low = data.low;
  if (data.open !== undefined) s.open = data.open;
  if (data.volume !== undefined) s.volume = data.volume;
  if (data.netChange !== undefined) s.netChange = data.netChange;
  if (data.netChangePct !== undefined) s.change = data.netChangePct;
  s.source = 'schwab';
  s.updatedAt = new Date().toISOString();
  runtimeStatus.schwab.connected = schwab.isConnected;
  runtimeStatus.schwab.lastTickAt = s.updatedAt;
}

async function refreshSupplementalContext() {
  const internals = await getMarketInternals();
  if (internals) {
    globalInternals = { ...globalInternals, ...internals };
  }

  const news = await getEconomicCalendar();
  if (Array.isArray(news)) {
    highImpactNews = news;
  }
}

function evaluatePendingSignals(price) {
  let closedCount = 0;
  let lossCount = 0;
  const pending = getPendingSignals(CONTRACT_ID);

  pending.forEach(sig => {
    let status = null;
    if (sig.side === 'BUY') {
      if (price >= sig.target) status = 'WIN';
      else if (price <= sig.stop) status = 'LOSS';
    } else {
      if (price <= sig.target) status = 'WIN';
      else if (price >= sig.stop) status = 'LOSS';
    }

    if (status) {
      setSignalStatus(sig.id, status);
      closedCount += 1;
      if (status === 'LOSS') lossCount += 1;
      console.log(`\n${status === 'WIN' ? '✅' : '⚠️'} Signal ${status} recorded for ${sig.algo_name}`);
    }
  });

  return { closedCount, lossCount };
}

function evaluateOpenPaperOrders(price) {
  const openOrders = getOpenPaperOrders(CONTRACT_ID);
  openOrders.forEach(order => {
    let status = null;
    if (order.side === 'BUY') {
      if (price >= order.take_profit) status = 'WIN';
      else if (price <= order.stop_loss) status = 'LOSS';
    } else {
      if (price <= order.take_profit) status = 'WIN';
      else if (price >= order.stop_loss) status = 'LOSS';
    }

    if (status) {
      updatePaperOrder(order.id, status, price);
      console.log(`\n📦 Paper Order ${order.id} closed: ${status} @ ${price}`);
    }
  });
}

async function main() {
  console.log(`🚀 Starting Trader Workstation (${DATA_PROVIDER} mode)…`);
  cleanupOldData(7);

  const io = startDashboard(runtimeStatus);
  refreshSupplementalContext().catch(err => console.error('[CONTEXT] Initial refresh failed:', err.message));
  setInterval(() => {
    refreshSupplementalContext().catch(err => console.error('[CONTEXT] Refresh failed:', err.message));
  }, 60000);

  if (SCHWAB_ENABLED) {
    schwab.start((service, symbol, data) => mergeMarketContext(symbol, data));
  }

  if (!hasTopstepCredentials()) {
    runtimeStatus.topstepx.enabled = false;
    runtimeStatus.topstepx.error = 'TopstepX credentials not configured; dashboard and Schwab context remain available.';
    io.emit('provider_status', runtimeStatus);
    console.warn(`[TOPSTEPX] ${runtimeStatus.topstepx.error}`);
    return;
  }

  let token;
  try {
    token = await getToken({ exitOnError: false });
    runtimeStatus.topstepx.connected = true;
    runtimeStatus.topstepx.error = null;
    console.log('✅ TopstepX authenticated');
  } catch (err) {
    runtimeStatus.topstepx.connected = false;
    runtimeStatus.topstepx.error = err.message;
    io.emit('provider_status', runtimeStatus);
    console.error(`[TOPSTEPX] ${err.message}`);
    return;
  }

  let lastSignalTimePerAlgo = {};
  let consecutiveLosses = 0;
  const MAX_CONSECUTIVE_LOSSES = 3;
  const DAILY_DRAWDOWN_LIMIT = -1000;
  const priorDayLevels = getPriorDayLevels(CONTRACT_ID);
  let currentPrice = 0;
  let lastStatSave = 0;
  let currentDom = { bids: [], asks: [] };

  await startStream(token, async (update) => {
    if (update.type === 'depth') {
      currentDom = update.dom;
      io.emit('depth', update.dom);
      return;
    }

    runtimeStatus.topstepx.connected = true;
    runtimeStatus.topstepx.lastTickAt = new Date().toISOString();
    runtimeStatus.topstepx.error = null;

    if (update.type === 'quote') {
      io.emit('tick', {
        type: update.type,
        price: currentPrice,
        bid: update.bid,
        ask: update.ask,
        indicators: update.indicators,
        dailyPnL: getDailyPnL(CONTRACT_ID),
        internals: globalInternals,
        news: highImpactNews,
        dom: currentDom,
        providerStatus: runtimeStatus
      });
      return;
    }

    const { price, size, ts, bars, tickBars, indicators } = update;
    currentPrice = price;
    process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Price: ${price.toFixed(2)} Size: ${size}   `);

    const signalResult = evaluatePendingSignals(price);
    if (signalResult.closedCount > 0) {
      consecutiveLosses = signalResult.lossCount > 0 ? consecutiveLosses + signalResult.lossCount : 0;
    }
    evaluateOpenPaperOrders(price);

    const dailyPnL = getDailyPnL(CONTRACT_ID);
    const isCircuitBroken = consecutiveLosses >= MAX_CONSECUTIVE_LOSSES || dailyPnL.pnl <= DAILY_DRAWDOWN_LIMIT;
    if (isCircuitBroken) {
      process.stdout.write(`\r[HALTED] Risk limit reached. PnL: $${dailyPnL.pnl} | Losses: ${consecutiveLosses}   `);
    }

    const history = getRecentBars(CONTRACT_ID, '1m', 250);
    const result = await getSignals(price, history, indicators, indicators.vwap, globalInternals, indicators, priorDayLevels);

    const now = Date.now();
    if (!isCircuitBroken && result.signals.length > 0) {
      result.signals.forEach(s => {
        const lastTime = lastSignalTimePerAlgo[s.type] || 0;
        if (now - lastTime <= 300000) return;

        const dbResult = saveSignal({
          symbol: CONTRACT_ID,
          algo_name: s.type,
          side: s.side,
          entry_price: price,
          target1: s.target1,
          target2: s.target2,
          target: s.target,
          stop: s.stop,
          reasons: s.reasons
        });
        lastSignalTimePerAlgo[s.type] = now;
        console.log(`\n🚀 ${s.type} ${s.side} Signal Fired @ ${price}`);

        if (s.score >= 75) {
          savePaperOrder({
            symbol: CONTRACT_ID,
            side: s.side,
            price,
            quantity: 1,
            signal_id: dbResult.lastInsertRowid,
            stop_loss: s.stop,
            take_profit: s.target
          });
          console.log(`\n💼 AUTO-TRADE: Opened ${s.side} position for ${s.type} (Score: ${s.score})`);
        }
      });
    }

    const algoStats = getAlgoStats(CONTRACT_ID);
    const algoDetailed = getAlgoStatsDetailed(CONTRACT_ID);

    if (now - lastStatSave > 300000) {
      saveSessionStats({
        symbol: CONTRACT_ID,
        date: new Date().toISOString().split('T')[0],
        vah: indicators.va.vah,
        val: indicators.va.val,
        poc: indicators.va.poc,
        asia_high: indicators.asia.high,
        asia_low: indicators.asia.low,
        ib_high: indicators.ib.high,
        ib_low: indicators.ib.low,
        orb1_high: indicators.orb1.high,
        orb1_low: indicators.orb1.low,
        orb5_high: indicators.orb5.high,
        orb5_low: indicators.orb5.low,
        orb15_high: indicators.orb15.high,
        orb15_low: indicators.orb15.low
      });
      lastStatSave = now;
    }

    io.emit('tick', {
      type: 'trade',
      price,
      size,
      ts,
      bars,
      tickBars,
      indicators: { ...indicators, ...result.indicators },
      signals: result.signals,
      confluence: result.confluence,
      structure: result.structure,
      priorDay: priorDayLevels,
      leaderboard: algoStats,
      leaderboardDetailed: algoDetailed,
      dailyPnL,
      internals: globalInternals,
      news: highImpactNews,
      positions: getOpenPaperOrders(CONTRACT_ID),
      providerStatus: runtimeStatus
    });
  });
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exitCode = 1;
});
