const { getToken } = require("./auth");
  const { startStream } = require("./stream");
  const { startDashboard } = require("./dashboard");
  const { getSignals } = require("./strategyEngine");
  const { getRecentBars } = require("./candleEngine");
  const { getPriorDayLevels, saveSignal, getPendingSignals, setSignalStatus, getAlgoStats, getAlgoStatsDetailed, getDailyPnL, cleanupOldData, saveSessionStats } = require("./database");
  const { CONTRACT_ID } = require("./config");
  const { getMarketInternals, getEconomicCalendar } = require("./marketInternals");
  
  // Cleanup old data on startup (7 days)
  cleanupOldData(7);

  let globalInternals = {};
  let highImpactNews = [];

  (async () => {
    console.log("🚀 Starting TopstepX Engine…");
    const token = await getToken();
    console.log("✅ Authenticated");

    const io = startDashboard();
    
    // Poll Market Internals & News every 60s
    setInterval(async () => {
      globalInternals = await getMarketInternals() || globalInternals;
      highImpactNews = await getEconomicCalendar() || highImpactNews;
    }, 60000);

    // Initial fetch
    getMarketInternals().then(data => globalInternals = data);
    getEconomicCalendar().then(data => highImpactNews = data);

    // Risk Management State
    let lastSignalTimePerAlgo = {}; 
    let consecutiveLosses = 0;
    const MAX_CONSECUTIVE_LOSSES = 3;
    const DAILY_DRAWDOWN_LIMIT = -1000; // Mock: $1000 loss limit for MNQ (approx 2% of $50k)

    // Fetch initial static day levels
    const priorDayLevels = getPriorDayLevels(CONTRACT_ID);
    let currentPrice = 0;
    let lastStatSave = 0;

    await startStream(token, async (update) => {
      // 0. Update Dashboard common stats regardless of type
      if (update.type === 'quote') {
        io.emit('tick', { 
          type: update.type,
          price: currentPrice, // last known
          indicators: update.indicators,
          dailyPnL: getDailyPnL(CONTRACT_ID),
          internals: globalInternals,
          news: highImpactNews
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

        if (status) {
          setSignalStatus(sig.id, status);
          if (status === 'LOSS') {
            consecutiveLosses++;
            console.log(`\n⚠️ Signal LOSS recorded. Consecutive: ${consecutiveLosses}`);
          } else {
            consecutiveLosses = 0;
            console.log(`\n✅ Signal WIN recorded. Circuit breaker reset.`);
          }
        }
      });

      // 2. Risk Checks (Circuit Breakers)
      const dailyPnL = getDailyPnL(CONTRACT_ID);
      const isCircuitBroken = consecutiveLosses >= MAX_CONSECUTIVE_LOSSES || dailyPnL.pnl <= DAILY_DRAWDOWN_LIMIT;

      if (isCircuitBroken) {
        process.stdout.write(`\r[HALTED] Risk limit reached. PnL: $${dailyPnL.pnl} | Losses: ${consecutiveLosses}   `);
      }

      // 3. Strategy Processing
      const history = getRecentBars(CONTRACT_ID, '1m', 250);
      const result = await getSignals(price, history, indicators, indicators.vwap, globalInternals, indicators, priorDayLevels);

      // Save new signals (if not halted and cooldown passed)
      const now = Date.now();
      if (!isCircuitBroken && result.signals.length > 0) {
        result.signals.forEach(s => {
          const lastTime = lastSignalTimePerAlgo[s.type] || 0;
          if (now - lastTime > 300000) { // 5-minute cooldown per specific algo
            saveSignal({
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
          }
        });
      }

      // Fetch Live Algo Stats for the Leaderboard
      const algoStats = getAlgoStats(CONTRACT_ID);
      const algoDetailed = getAlgoStatsDetailed(CONTRACT_ID);

      // 4. Persistence: Save Session Stats every 5 minutes
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

      // Push to dashboard
      io.emit('tick', { 
        price, size, ts, bars, tickBars, indicators, 
        signals: result.signals, 
        confluence: result.confluence,
        structure: result.structure,
        priorDay: priorDayLevels,
        leaderboard: algoStats,
        leaderboardDetailed: algoDetailed,
        dailyPnL,
        internals: globalInternals,
        news: highImpactNews
      });
    });
  })();
