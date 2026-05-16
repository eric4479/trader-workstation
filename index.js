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

  let globalInternals = { status: 'INITIALIZING', data: {} };
  let highImpactNews = { status: 'INITIALIZING', data: [] };
  let schwabStatus = 'OFFLINE';

  if (schwab.hasCredentials()) {
    schwabStatus = 'CONNECTING';
    schwab.start((service, symbol, data) => {
      schwabStatus = 'ACTIVE';
      if (!globalInternals.data[symbol]) globalInternals.data[symbol] = {};
      const s = globalInternals.data[symbol];
      if (data.last      !== undefined) s.price      = data.last;
      if (data.bid       !== undefined) s.bid        = data.bid;
      if (data.ask       !== undefined) s.ask        = data.ask;
      if (data.high      !== undefined) s.high       = data.high;
      if (data.low       !== undefined) s.low        = data.low;
      if (data.open      !== undefined) s.open       = data.open;
      if (data.volume    !== undefined) s.volume     = data.volume;
      if (data.netChange !== undefined) s.netChange  = data.netChange;
      if (data.netChangePct !== undefined) s.change  = data.netChangePct;
    });
  }

  (async () => {
    console.log("🚀 Starting TopstepX Engine…");
    const token = await getToken();
    console.log("✅ Authenticated");

    const io = startDashboard();
    
    // Poll Market Internals & News every 60s
    setInterval(async () => {
      const internals = await getMarketInternals();
      if (internals && internals.status === 'ACTIVE') {
        globalInternals.status = 'ACTIVE';
        Object.assign(globalInternals.data, internals.data);
      } else if (internals) {
        globalInternals.status = internals.status;
      }

      const news = await getEconomicCalendar();
      if (news) highImpactNews = news;
    }, 60000);

    // Initial fetch
    getMarketInternals().then(data => { if (data) globalInternals = data; });
    getEconomicCalendar().then(data => { if (data) highImpactNews = data; });

    // Risk Management State
    let lastSignalTimePerAlgo = {}; 
    let consecutiveLosses = 0;
    const MAX_CONSECUTIVE_LOSSES = 3;
    const DAILY_DRAWDOWN_LIMIT = -1000; // Mock: $1000 loss limit for MNQ (approx 2% of $50k)

    // Fetch initial static day levels
    const priorDayLevels = getPriorDayLevels(CONTRACT_ID);
    let currentPrice = 0;
    let lastStatSave = 0;
    let currentDom = { bids: [], asks: [] };

    await startStream(token, async (update) => {
      // DOM depth updates — store and re-emit with next quote/trade
      if (update.type === 'depth') {
        currentDom = update.dom;
        io.emit('depth', update.dom);
        return;
      }

      // 0. Update Dashboard common stats regardless of type
      if (update.type === 'quote') {
        io.emit('tick', {
          type: update.type,
          price: currentPrice, // last known
          bid: update.bid,
          ask: update.ask,
          indicators: update.indicators,
          dailyPnL: getDailyPnL(CONTRACT_ID),
          internals: globalInternals,
          news: highImpactNews,
          schwabStatus: schwabStatus,
          dom: currentDom
        });
        return;
      }

      // Handle 'trade' type
      const { price, size, ts, bars, tickBars, indicators } = update;
      currentPrice = price;
      process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Price: ${price.toFixed(2)} Size: ${size}   `);

      // 1. Evaluate PENDING signals & Update Risk State
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
        lastStatSave = now;
      }

      // Push to dashboard
      io.emit('tick', { 
        type: 'trade',
        price, size, ts, bars, tickBars, 
        indicators: { ...indicators, ...result.indicators, adx: result.indicators.adx, chop: result.indicators.chop, roc: result.indicators.roc },
        signals: result.signals, 
        confluence: result.confluence,
        structure: result.structure,
        priorDay: priorDayLevels,
        leaderboard: algoStats,
        leaderboardDetailed: algoDetailed,
        dailyPnL,
        internals: globalInternals,
        news: highImpactNews,
        schwabStatus: schwabStatus,
        positions: openOrders
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
