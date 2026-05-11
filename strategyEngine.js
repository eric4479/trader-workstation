const { MACD, RSI, ATR, EMA, SMA, StochasticOscillator, BollingerBands } = require('trading-signals');
const talib = require('talib');

function runTALibPattern(patternName, o, h, l, c) {
  return new Promise((resolve) => {
    talib.execute({
      name: patternName,
      startIdx: 0,
      endIdx: c.length - 1,
      open: o, high: h, low: l, close: c
    }, (err, result) => {
      if (err || !result.result || !result.result.outInteger) return resolve(0);
      resolve(result.result.outInteger[result.result.outInteger.length - 1]);
    });
  });
}

function getMarketStructure(bars) {
  if (bars.length < 20) return { structure: 'UNCERTAIN', swings: [], events: [] };

  const swings = [];
  const events = [];
  let currentTrend = 'Neutral';

  // 1. Detect Swings
  for (let i = 2; i < bars.length - 2; i++) {
    const isHigh = bars[i].high > bars[i-1].high && bars[i].high > bars[i-2].high && bars[i].high > bars[i+1].high && bars[i].high > bars[i+2].high;
    const isLow = bars[i].low < bars[i-1].low && bars[i].low < bars[i-2].low && bars[i].low < bars[i+1].low && bars[i].low < bars[i+2].low;
    
    if (isHigh) swings.push({ type: 'HH', price: bars[i].high, time: bars[i].timestamp, index: i });
    if (isLow) swings.push({ type: 'LL', price: bars[i].low, time: bars[i].timestamp, index: i });
  }

  if (swings.length < 3) return { trend: 'Neutral', swings, events };

  // 2. Identify Structure Events (BOS/CHoCH)
  let lastHH = -Infinity;
  let lastLL = Infinity;
  let lastHL = Infinity;
  let lastLH = -Infinity;

  for (let i = 0; i < swings.length; i++) {
    const s = swings[i];
    if (s.type === 'HH') {
      if (s.price > lastHH) {
        if (currentTrend === 'Bullish') events.push({ type: 'BOS', side: 'BULLISH', price: s.price, time: s.time });
        lastHH = s.price;
      } else {
        // Lower High
        if (currentTrend === 'Bullish') {
          currentTrend = 'Neutral';
          events.push({ type: 'CHoCH', side: 'BEARISH', price: s.price, time: s.time });
        }
        lastLH = s.price;
      }
    } else {
      if (s.price < lastLL) {
        if (currentTrend === 'Bearish') events.push({ type: 'BOS', side: 'BEARISH', price: s.price, time: s.time });
        lastLL = s.price;
      } else {
        // Higher Low
        if (currentTrend === 'Bearish') {
          currentTrend = 'Neutral';
          events.push({ type: 'CHoCH', side: 'BULLISH', price: s.price, time: s.time });
        }
        lastHL = s.price;
      }
    }
    
    // Initial Trend Assignment
    if (i === 2 && currentTrend === 'Neutral') {
       if (swings[i].price > swings[i-2].price && swings[i].type === 'HH') currentTrend = 'Bullish';
       if (swings[i].price < swings[i-2].price && swings[i].type === 'LL') currentTrend = 'Bearish';
    }
  }

  return { trend: currentTrend, swings: swings.slice(-10), events: events.slice(-5) };
}

function runIndicators(bars) {
  const rsi = new RSI(14);
  const atr = new ATR(14);
  const ema9 = new EMA(9);
  const ema21 = new EMA(21);
  const ema50 = new EMA(50);
  const ema200 = new EMA(200);
  const macd = new MACD(new EMA(12), new EMA(26), new EMA(9));
  const bb = new BollingerBands(20, 2);
  const stoch = new StochasticOscillator(14, 3, 3);
  
  bars.forEach(b => {
    rsi.update(b.close);
    atr.update({ high: b.high, low: b.low, close: b.close });
    ema9.update(b.close);
    ema21.update(b.close);
    ema50.update(b.close);
    ema200.update(b.close);
    macd.update(b.close);
    bb.update(b.close);
    stoch.update({ high: b.high, low: b.low, close: b.close });
  });

  return {
    rsi: rsi.isStable ? rsi.getResult().valueOf() : 50,
    atr: atr.isStable ? atr.getResult().valueOf() : 0,
    ema9: ema9.isStable ? ema9.getResult().valueOf() : null,
    ema21: ema21.isStable ? ema21.getResult().valueOf() : null,
    ema50: ema50.isStable ? ema50.getResult().valueOf() : null,
    ema200: ema200.isStable ? ema200.getResult().valueOf() : null,
    macd: macd.isStable ? macd.getResult() : { macd: 0, signal: 0, histogram: 0 },
    bb: bb.isStable ? bb.getResult() : null,
    stoch: stoch.isStable ? stoch.getResult() : null
  };
}

async function getAlgorithms(currentPrice, ind, orb, vwap, bars, session = {}, priorDay = {}) {
  const signals = [];
  if (bars.length < 20) return signals;

  const { asia, ib, va } = session;
  const { vah: pVah, val: pVal } = priorDay;

  const o = bars.map(b => b.open);
  const h = bars.map(b => b.high);
  const l = bars.map(b => b.low);
  const c = bars.map(b => b.close);
  const v = bars.map(b => b.volume);
  
  const [engulfing, hammer, morningStar, shootingStar, marubozu] = await Promise.all([
    runTALibPattern("CDLENGULFING", o, h, l, c),
    runTALibPattern("CDLHAMMER", o, h, l, c),
    runTALibPattern("CDLMORNINGSTAR", o, h, l, c),
    runTALibPattern("CDLSHOOTINGSTAR", o, h, l, c),
    runTALibPattern("CDLMARUBOZU", o, h, l, c)
  ]);

  // 1. ALGO_MEAN_REVERSION
  if (ind.bb && ind.stoch) {
    if (currentPrice < ind.bb.lower.valueOf() && ind.rsi < 30 && (engulfing > 0 || hammer > 0 || morningStar > 0)) {
      signals.push({ algo: 'ALGO_MEAN_REVERSION', side: 'BUY', reasons: ['Below BB', 'RSI Oversold', 'Reversal Candle'] });
    } else if (currentPrice > ind.bb.upper.valueOf() && ind.rsi > 70 && (engulfing < 0 || shootingStar < 0)) {
      signals.push({ algo: 'ALGO_MEAN_REVERSION', side: 'SELL', reasons: ['Above BB', 'RSI Overbought', 'Reversal Candle'] });
    }
  }

  // 2. ALGO_MOMENTUM_BREAKOUT (ORB)
  const orbs = [
    { name: 'ORB1', data: session.orb1 },
    { name: 'ORB5', data: session.orb5 },
    { name: 'ORB15', data: session.orb15 }
  ];

  orbs.forEach(orb => {
    if (orb.data && orb.data.set && ind.macd.histogram !== 0) {
      if (currentPrice > orb.data.high && ind.macd.histogram > 0 && marubozu > 0) {
        signals.push({ algo: `ALGO_MOMENTUM_BREAKOUT_${orb.name}`, side: 'BUY', reasons: [`${orb.name} High Break`, 'MACD Bullish', 'Marubozu'] });
      } else if (currentPrice < orb.data.low && ind.macd.histogram < 0 && marubozu < 0) {
        signals.push({ algo: `ALGO_MOMENTUM_BREAKOUT_${orb.name}`, side: 'SELL', reasons: [`${orb.name} Low Break`, 'MACD Bearish', 'Marubozu'] });
      }
    }
  });

  // 3. ALGO_TREND_PULLBACK
  if (ind.ema50 && ind.ema200) {
    const isBullishMacro = currentPrice > ind.ema200;
    const isBearishMacro = currentPrice < ind.ema200;
    const nearVWAP = Math.abs(currentPrice - vwap) < ind.atr;
    const nearEMA50 = Math.abs(currentPrice - ind.ema50) < ind.atr;

    if (isBullishMacro && (nearVWAP || nearEMA50) && (hammer > 0 || engulfing > 0)) {
      signals.push({ algo: 'ALGO_TREND_PULLBACK', side: 'BUY', reasons: ['Macro Bullish', 'Support Bounce', 'Bullish Candle'] });
    } else if (isBearishMacro && (nearVWAP || nearEMA50) && (shootingStar < 0 || engulfing < 0)) {
      signals.push({ algo: 'ALGO_TREND_PULLBACK', side: 'SELL', reasons: ['Macro Bearish', 'Resistance Reject', 'Bearish Candle'] });
    }
  }

  // 4. ALGO_VOLUME_BREAKOUT (New)
  if (ind.bb && v.length > 20) {
    const avgVol = v.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVol = v[v.length - 1];
    if (currentPrice > ind.bb.upper.valueOf() && currentVol > avgVol * 1.5) {
      signals.push({ algo: 'ALGO_VOLUME_BREAKOUT', side: 'BUY', reasons: ['BB Upper Break', 'High Volume Surge'] });
    } else if (currentPrice < ind.bb.lower.valueOf() && currentVol > avgVol * 1.5) {
      signals.push({ algo: 'ALGO_VOLUME_BREAKOUT', side: 'SELL', reasons: ['BB Lower Break', 'High Volume Surge'] });
    }
  }

  // 5. ALGO_EMA_CROSSOVER (New)
  if (ind.ema9 && ind.ema21) {
    const prevC = bars[bars.length - 2].close;
    const prevEMA9 = ind.ema9 - (currentPrice - prevC) / 5; // Rough approx for cross check
    const prevEMA21 = ind.ema21 - (currentPrice - prevC) / 11;
    
    if (ind.ema9 > ind.ema21 && prevEMA9 <= prevEMA21) {
      signals.push({ algo: 'ALGO_EMA_CROSSOVER', side: 'BUY', reasons: ['EMA 9/21 Bull Cross'] });
    } else if (ind.ema9 < ind.ema21 && prevEMA9 >= prevEMA21) {
      signals.push({ algo: 'ALGO_EMA_CROSSOVER', side: 'SELL', reasons: ['EMA 9/21 Bear Cross'] });
    }
  }

  // 7. ALGO_SESSION_EDGE (Asia/IB Breakout)
  if (asia && asia.high && asia.low) {
    if (currentPrice > asia.high && ind.rsi > 50) {
      signals.push({ algo: 'ALGO_SESSION_EDGE', side: 'BUY', reasons: ['Asia High Breakout', 'RSI Bullish'] });
    } else if (currentPrice < asia.low && ind.rsi < 50) {
      signals.push({ algo: 'ALGO_SESSION_EDGE', side: 'SELL', reasons: ['Asia Low Breakout', 'RSI Bearish'] });
    }
  }
  if (ib && ib.set) {
    if (currentPrice > ib.high && ind.macd.histogram > 0) {
      signals.push({ algo: 'ALGO_SESSION_EDGE', side: 'BUY', reasons: ['IB High Breakout', 'MACD Bullish'] });
    } else if (currentPrice < ib.low && ind.macd.histogram < 0) {
      signals.push({ algo: 'ALGO_SESSION_EDGE', side: 'SELL', reasons: ['IB Low Breakout', 'MACD Bearish'] });
    }
  }

  // 8. ALGO_VALUE_AREA_REENTRY (80% Rule)
  if (pVah && pVal) {
    const prevC = bars[bars.length - 2].close;
    // Entry into VA from above
    if (prevC > pVah && currentPrice <= pVah) {
      signals.push({ algo: 'ALGO_VALUE_AREA_REENTRY', side: 'SELL', reasons: ['Re-entry into Prior Day VA (Bearish)', 'Target: Prior VAL'] });
    }
    // Entry into VA from below
    else if (prevC < pVal && currentPrice >= pVal) {
      signals.push({ algo: 'ALGO_VALUE_AREA_REENTRY', side: 'BUY', reasons: ['Re-entry into Prior Day VA (Bullish)', 'Target: Prior VAH'] });
    }
  }

  // 9. ALGO_DELTA_DIVERGENCE (Exhaustion/Absorption)
  if (bars.length >= 10) {
    const recentBars = bars.slice(-10);
    // Calculate cumulative delta for the window
    let windowDelta = 0;
    const deltas = recentBars.map(b => {
      windowDelta += (b.delta || 0);
      return windowDelta;
    });

    const lastIdx = deltas.length - 1;
    const prevDeltas = deltas.slice(0, -1);
    const prevHighs = recentBars.slice(0, -1).map(b => b.high);
    const prevLows = recentBars.slice(0, -1).map(b => b.low);

    const maxPrevHigh = Math.max(...prevHighs);
    const maxPrevDelta = Math.max(...prevDeltas);
    const minPrevLow = Math.min(...prevLows);
    const minPrevDelta = Math.min(...prevDeltas);

    // Bearish Divergence: Price making new high, Delta failing to make new high
    if (currentPrice > maxPrevHigh && deltas[lastIdx] < maxPrevDelta) {
      signals.push({ algo: 'ALGO_DELTA_DIVERGENCE', side: 'SELL', reasons: ['Price New High', 'Delta Divergence (Buying Exhaustion)'] });
    }
    // Bullish Divergence: Price making new low, Delta failing to make new low
    else if (currentPrice < minPrevLow && deltas[lastIdx] > minPrevDelta) {
      signals.push({ algo: 'ALGO_DELTA_DIVERGENCE', side: 'BUY', reasons: ['Price New Low', 'Delta Divergence (Selling Exhaustion)'] });
    }
  }

  return signals;
}

async function getSignals(currentPrice, bars, indicators, vwap, internals = null, session = {}, priorDay = {}) {
  if (!bars || bars.length === 0) return { signals: [], structure: null, indicators: null };

  const structure = getMarketStructure(bars);
  const ind = runIndicators(bars);
  // We use the full session object now
  const rawSignals = await getAlgorithms(currentPrice, ind, null, vwap, bars, session, priorDay);

  // Macro Confirmation Logic
  const isVixSpiking = internals && internals.VIX && internals.VIX.price > 20;

  // Format and Filter the signals
  const finalSignals = rawSignals.filter(s => {
    // Block BUYS if VIX is high (Extreme fear)
    if (s.side === 'BUY' && isVixSpiking) return false;
    return true;
  }).map(s => {
    const isBuy = s.side === 'BUY';
    const t1 = isBuy ? currentPrice + ind.atr * 1.2 : currentPrice - ind.atr * 1.2;
    const t2 = isBuy ? currentPrice + ind.atr * 2.5 : currentPrice - ind.atr * 2.5;
    
    // Weighting: Session edges and VA re-entry get higher base scores
    let baseScore = 40;
    if (s.algo === 'ALGO_SESSION_EDGE' || s.algo === 'ALGO_VALUE_AREA_REENTRY' || s.algo === 'ALGO_DELTA_DIVERGENCE') baseScore = 60;
    
    const score = Math.min(100, baseScore + (s.reasons.length * 20));

    let target = t2;
    // Specific target for 80% rule
    if (s.algo === 'ALGO_VALUE_AREA_REENTRY') {
       target = s.side === 'BUY' ? priorDay.vah : priorDay.val;
    }

    return {
      type: s.algo,
      side: s.side,
      reasons: s.reasons,
      score: score, 
      entry: currentPrice,
      target1: t1,
      target2: t2,
      target: target,
      stop: isBuy ? currentPrice - ind.atr * 1.5 : currentPrice + ind.atr * 1.5
    };
  });

  // Real confluence score (aggregate conviction)
  let totalConviction = 0;
  let aggregateReasons = [];
  
  finalSignals.forEach(s => {
    const factor = s.side === 'BUY' ? 1 : -1;
    totalConviction += (s.score * factor);
    aggregateReasons = [...new Set([...aggregateReasons, ...s.reasons])];
  });

  // Clamp totalConviction to [-100, 100]
  const confluenceScore = Math.max(-100, Math.min(100, totalConviction));

  const confluence = {
    score: confluenceScore,
    reasons: aggregateReasons
  };

  return { 
    signals: finalSignals, 
    confluence,
    structure, 
    indicators: ind 
  };
}

module.exports = { getSignals };
