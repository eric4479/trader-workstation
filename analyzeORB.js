const { db } = require('./database');
const { DateTime } = require('luxon');
const { CONTRACT_ID } = require('./config');

function analyzeORB(timeframeMinutes, targetPoints = 10, stopPoints = 10) {
  // Fetch all 1m candles for precise backtesting
  const stmt = db.prepare(`
    SELECT * FROM candles 
    WHERE symbol = ? AND timeframe = '1m'
    ORDER BY timestamp ASC
  `);
  const candles = stmt.all(CONTRACT_ID);

  if (candles.length === 0) {
    console.log("No 1m candles found in database. Run downloadHistory.js first.");
    return;
  }

  // Group candles by day (trading day in America/New_York)
  const days = {};
  for (const c of candles) {
    // TopstepX timestamps are UTC
    const dt = DateTime.fromISO(c.timestamp, { zone: 'utc' }).setZone('America/New_York');
    const dayStr = dt.toFormat('yyyy-MM-dd');
    if (!days[dayStr]) days[dayStr] = [];
    
    // Only care about RTH (Regular Trading Hours) 09:30 - 16:00
    if ((dt.hour === 9 && dt.minute >= 30) || (dt.hour >= 10 && dt.hour < 16)) {
      days[dayStr].push({
        dt,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      });
    }
  }

  let totalTrades = 0;
  let wins = 0;
  let losses = 0;

  for (const [day, dayCandles] of Object.entries(days)) {
    // Sort just in case
    dayCandles.sort((a, b) => a.dt.valueOf() - b.dt.valueOf());
    
    // Need at least the opening range + some data to trade
    if (dayCandles.length < timeframeMinutes + 10) continue;

    // Find the opening range
    const openingRangeCandles = dayCandles.filter(c => 
      c.dt.hour === 9 && c.dt.minute >= 30 && c.dt.minute < 30 + timeframeMinutes
    );

    if (openingRangeCandles.length === 0) continue;

    const orHigh = Math.max(...openingRangeCandles.map(c => c.high));
    const orLow = Math.min(...openingRangeCandles.map(c => c.low));

    // Look for breakout after the opening range
    let position = null; // 'long' or 'short'
    let entryPrice = 0;
    
    for (const c of dayCandles) {
      // Skip the opening range period
      if (c.dt.hour === 9 && c.dt.minute < 30 + timeframeMinutes) continue;

      if (!position) {
        // Check for entry
        if (c.high > orHigh) {
          position = 'long';
          entryPrice = orHigh; // assuming entry on stop order
        } else if (c.low < orLow) {
          position = 'short';
          entryPrice = orLow;
        }
      }

      if (position) {
        // Evaluate exit
        if (position === 'long') {
          if (c.high >= entryPrice + targetPoints) {
            wins++;
            totalTrades++;
            break;
          } else if (c.low <= entryPrice - stopPoints) {
            losses++;
            totalTrades++;
            break;
          }
        } else if (position === 'short') {
          if (c.low <= entryPrice - targetPoints) {
            wins++;
            totalTrades++;
            break;
          } else if (c.high >= entryPrice + stopPoints) {
            losses++;
            totalTrades++;
            break;
          }
        }
      }
    }
  }

  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0;
  console.log(`ORB ${timeframeMinutes}min | Trades: ${totalTrades} | Wins: ${wins} | Losses: ${losses} | Win Rate: ${winRate}%`);
}

function runAnalysis() {
  console.log(`\n--- ORB Strategy Analysis for ${CONTRACT_ID} ---`);
  console.log(`Target: 10 pts, Stop: 10 pts`);
  analyzeORB(1, 10, 10);
  analyzeORB(5, 10, 10);
  analyzeORB(15, 10, 10);
  
  console.log(`\nTarget: 20 pts, Stop: 10 pts`);
  analyzeORB(1, 20, 10);
  analyzeORB(5, 20, 10);
  analyzeORB(15, 20, 10);
  console.log("------------------------------------------\n");
}

if (require.main === module) {
  runAnalysis();
}

module.exports = { analyzeORB };
