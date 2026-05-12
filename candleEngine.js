const { DateTime } = require('luxon');
const { saveCandle } = require('./database');

const TIMEFRAMES = [
  { tf: '1m',  unit: 2, interval: 1 },
  { tf: '5m',  unit: 2, interval: 5 },
  { tf: '15m', unit: 2, interval: 15 },
  { tf: '30m', unit: 2, interval: 30 },
  { tf: '1h',  unit: 3, interval: 1 },
];

const TICK_SIZES = [100, 500, 1000];

const timeState = {};    
const tickState  = {};   
const indicatorState = {
  vwap: { cumPV: 0, cumV: 0, lastDay: null },
  volumeProfile: {}, // price -> volume
  va: { vah: null, val: null, poc: null },
  sessionLevels: { high: -Infinity, low: Infinity, open: null, startTime: null },
  orb1: { high: null, low: null, set: false },
  orb5: { high: null, low: null, set: false },
  orb15: { high: null, low: null, set: false },
  asia: { high: null, low: null },
  ib: { high: null, low: null, set: false },
  market: { bid: null, bidSize: null, ask: null, askSize: null, high: null, low: null, volume: null },
  cumDelta: 0
};

function calculateValueArea(profile) {
  const prices = Object.keys(profile).map(Number).sort((a, b) => a - b);
  if (prices.length === 0) return { vah: null, val: null, poc: null };

  let totalVolume = 0;
  let poc = prices[0];
  let maxVol = -1;

  for (const p of prices) {
    const v = profile[p];
    totalVolume += v;
    if (v > maxVol) {
      maxVol = v;
      poc = p;
    }
  }

  const targetVolume = totalVolume * 0.70;
  let currentVolume = maxVol;
  let lowIdx = prices.indexOf(poc);
  let highIdx = lowIdx;

  // Ensure we don't get stuck if targetVolume is 0 or sparse data
  if (targetVolume <= 0) return { vah: poc, val: poc, poc: poc };

  while (currentVolume < targetVolume && (lowIdx > 0 || highIdx < prices.length - 1)) {
    const volBelow = (lowIdx > 0) ? (profile[prices[lowIdx - 1]] || 0) + (profile[prices[lowIdx - 2]] || 0) : 0;
    const volAbove = (highIdx < prices.length - 1) ? (profile[prices[highIdx + 1]] || 0) + (profile[prices[highIdx + 2]] || 0) : 0;

    if (volAbove >= volBelow && highIdx < prices.length - 1) {
      currentVolume += (profile[prices[highIdx + 1]] || 0);
      highIdx++;
      if (highIdx < prices.length - 1) {
        currentVolume += (profile[prices[highIdx + 1]] || 0);
        highIdx++;
      }
    } else if (lowIdx > 0) {
      currentVolume += (profile[prices[lowIdx - 1]] || 0);
      lowIdx--;
      if (lowIdx > 0) {
        currentVolume += (profile[prices[lowIdx - 1]] || 0);
        lowIdx--;
      }
    } else {
      break;
    }
  }

  return {
    vah: prices[Math.min(highIdx, prices.length - 1)] || poc,
    val: prices[Math.max(lowIdx, 0)] || poc,
    poc: poc
  };
}

function getTimeKey(timestamp, unit, interval) {
  const dt = DateTime.fromISO(timestamp, { zone: 'utc' });
  let floored;
  if (unit === 2) {
    const m = Math.floor(dt.minute / interval) * interval;
    floored = dt.set({ minute: m, second: 0, millisecond: 0 });
  } else if (unit === 3) {
    const h = Math.floor(dt.hour / interval) * interval;
    floored = dt.set({ hour: h, minute: 0, second: 0, millisecond: 0 });
  } else {
    floored = dt.set({ second: 0, millisecond: 0 });
  }
  return floored.toISO({ suppressMilliseconds: true });
}

function updateCandles(symbol, data) {
  if (data.type === 'quote') {
    indicatorState.market.bid = data.bidPrice;
    indicatorState.market.bidSize = data.bidSize;
    indicatorState.market.ask = data.askPrice;
    indicatorState.market.askSize = data.askSize;
    return { 
      timeState, 
      tickState, 
      indicators: { 
        ...indicatorState, 
        vwap: indicatorState.vwap.cumV > 0 ? indicatorState.vwap.cumPV / indicatorState.vwap.cumV : null,
        market: { ...indicatorState.market } 
      } 
    };
  }

  if (data.type === 'summary') {
    indicatorState.market.high = data.high;
    indicatorState.market.low = data.low;
    indicatorState.market.volume = data.volume;
    return { 
      timeState, 
      tickState, 
      indicators: { 
        ...indicatorState, 
        vwap: indicatorState.vwap.cumV > 0 ? indicatorState.vwap.cumPV / indicatorState.vwap.cumV : null,
        market: { ...indicatorState.market } 
      } 
    };
  }

  // Handle Trade logic (as before)
  const price = data.price ?? data.p;
  const size  = data.size  ?? data.v ?? 1;
  const ts    = data.timestamp ?? data.t ?? new Date().toISOString();
  if (!price) return { timeState, tickState, indicators: indicatorState };

  const dt = DateTime.fromISO(ts, { zone: 'utc' });
  const dayStr = dt.toFormat('yyyy-MM-dd');

  // --- Session Reset ---
  if (indicatorState.vwap.lastDay !== dayStr) {
    indicatorState.vwap.cumPV = 0;
    indicatorState.vwap.cumV = 0;
    indicatorState.vwap.lastDay = dayStr;
    indicatorState.volumeProfile = {};
    indicatorState.va = { vah: null, val: null, poc: null };
    indicatorState.sessionLevels = { high: price, low: price, open: price, startTime: dt };
    indicatorState.orb1 = { high: null, low: null, set: false };
    indicatorState.orb5 = { high: null, low: null, set: false };
    indicatorState.orb15 = { high: null, low: null, set: false };
    indicatorState.ib = { high: null, low: null, set: false };
    indicatorState.asia = { high: null, low: null };
  }

  const nyTime = dt.setZone('America/New_York');

  // --- Asia Session Capture (18:00 - 02:00 ET) ---
  const isAsia = nyTime.hour >= 18 || nyTime.hour < 2;
  if (isAsia) {
    indicatorState.asia.high = Math.max(indicatorState.asia.high ?? -Infinity, price);
    indicatorState.asia.low = Math.min(indicatorState.asia.low ?? Infinity, price);
  }

  // --- Multi-Timeframe ORB Capture (Starting 09:30 ET) ---
  const nyHour = nyTime.hour;
  const nyMin  = nyTime.minute;

  // 1-min ORB (09:30 - 09:31)
  if (nyHour === 9 && nyMin === 30) {
    indicatorState.orb1.high = Math.max(indicatorState.orb1.high ?? -Infinity, price);
    indicatorState.orb1.low = Math.min(indicatorState.orb1.low ?? Infinity, price);
  } else if (nyHour === 9 && nyMin >= 31 && !indicatorState.orb1.set) {
    if (indicatorState.orb1.high !== null) indicatorState.orb1.set = true;
  }

  // 5-min ORB (09:30 - 09:35)
  if (nyHour === 9 && nyMin >= 30 && nyMin < 35) {
    indicatorState.orb5.high = Math.max(indicatorState.orb5.high ?? -Infinity, price);
    indicatorState.orb5.low = Math.min(indicatorState.orb5.low ?? Infinity, price);
  } else if (nyHour === 9 && nyMin >= 35 && !indicatorState.orb5.set) {
    if (indicatorState.orb5.high !== null) indicatorState.orb5.set = true;
  }

  // 15-min ORB (09:30 - 09:45)
  if (nyHour === 9 && nyMin >= 30 && nyMin < 45) {
    indicatorState.orb15.high = Math.max(indicatorState.orb15.high ?? -Infinity, price);
    indicatorState.orb15.low = Math.min(indicatorState.orb15.low ?? Infinity, price);
  } else if (nyHour === 9 && nyMin >= 45 && !indicatorState.orb15.set) {
    if (indicatorState.orb15.high !== null) indicatorState.orb15.set = true;
  }

  // --- Initial Balance (IB) Capture (09:30 - 10:30 ET) ---
  const isIBWindow = (nyTime.hour === 9 && nyTime.minute >= 30) || (nyTime.hour === 10 && nyTime.minute < 30);
  if (isIBWindow) {
    indicatorState.ib.high = Math.max(indicatorState.ib.high ?? -Infinity, price);
    indicatorState.ib.low = Math.min(indicatorState.ib.low ?? Infinity, price);
  } else if (nyTime.hour === 10 && nyTime.minute >= 30 && !indicatorState.ib.set) {
    if (indicatorState.ib.high !== null) {
      indicatorState.ib.set = true;
      console.log(`[ENGINE] IB Set: ${indicatorState.ib.high} / ${indicatorState.ib.low}`);
    }
  }

  // --- Volume Profile Update ---
  const roundedPrice = Math.round(price * 4) / 4; // Tick size 0.25 for MNQ
  indicatorState.volumeProfile[roundedPrice] = (indicatorState.volumeProfile[roundedPrice] || 0) + size;
  
  // Throttle VA calculation (every 100 trades or every 5 seconds)
  if (!indicatorState._lastVACalc || Date.now() - indicatorState._lastVACalc > 5000) {
    indicatorState.va = calculateValueArea(indicatorState.volumeProfile);
    indicatorState._lastVACalc = Date.now();
  }

  // --- Session Levels ---
  indicatorState.sessionLevels.high = Math.max(indicatorState.sessionLevels.high, price);
  indicatorState.sessionLevels.low = Math.min(indicatorState.sessionLevels.low, price);

  // --- Cumulative Delta ---
  const side = data.side || data.s;
  let tickDelta = 0;
  if (side === 1) {
    indicatorState.cumDelta += size;
    tickDelta = size;
  } else if (side === 2) {
    indicatorState.cumDelta -= size;
    tickDelta = -size;
  }

  // --- VWAP ---
  indicatorState.vwap.cumPV += price * size;
  indicatorState.vwap.cumV += size;
  const currentVWAP = indicatorState.vwap.cumPV / indicatorState.vwap.cumV;

  // --- Time-based candles ---
  for (const { tf, unit, interval } of TIMEFRAMES) {
    const key = `${symbol}_${tf}`;
    const timeKey = getTimeKey(ts, unit, interval);
    if (!timeState[key]) timeState[key] = {};
    if (!timeState[key][timeKey]) {
      timeState[key][timeKey] = { symbol, timeframe: tf, timestamp: timeKey, open: price, high: price, low: price, close: price, volume: size, delta: tickDelta, vwap: currentVWAP };
    } else {
      const c = timeState[key][timeKey];
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
      c.volume += size;
      c.delta += tickDelta;
      c.vwap = currentVWAP;
    }
    saveCandle(timeState[key][timeKey]);
  }

  // --- Tick bars ---
  const closedTickBars = {};
  for (const tickSize of TICK_SIZES) {
    const key = `${symbol}_${tickSize}t`;
    if (!tickState[key]) tickState[key] = null;
    if (!tickState[key]) {
      tickState[key] = { symbol, timeframe: `${tickSize}t`, timestamp: ts, open: price, high: price, low: price, close: price, volume: size, delta: tickDelta, ticks: 1, vwap: currentVWAP };
    } else {
      const bar = tickState[key];
      bar.high = Math.max(bar.high, price);
      bar.low = Math.min(bar.low, price);
      bar.close = price;
      bar.volume += size;
      bar.delta += tickDelta;
      bar.ticks += 1;
      if (bar.ticks >= tickSize) {
        saveCandle({ ...bar });
        closedTickBars[`${tickSize}t`] = { ...bar };
        tickState[key] = null;
      }
    }
  }

  return { 
    timeState, 
    tickState, 
    closedTickBars, 
    indicators: { 
      vwap: currentVWAP, 
      volumeProfile: indicatorState.volumeProfile,
      va: indicatorState.va,
      session: indicatorState.sessionLevels,
      orb1: indicatorState.orb1,
      orb5: indicatorState.orb5,
      orb15: indicatorState.orb15,
      ib: indicatorState.ib,
      asia: indicatorState.asia,
      market: indicatorState.market,
      cumDelta: indicatorState.cumDelta
    } 
  };
}

function getRecentBars(symbol, tf, limit = 100) {
  const key = `${symbol}_${tf}`;
  if (!timeState[key]) return [];
  return Object.values(timeState[key]).sort((a,b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit);
}

module.exports = { updateCandles, getRecentBars, timeState, tickState };
