const { db } = require('./database');
const { CONTRACT_ID } = require('./config');

const stats = db.prepare(`SELECT timeframe, count(*) as count FROM candles WHERE symbol = ? GROUP BY timeframe`).all(CONTRACT_ID);
console.log("Database Stats for " + CONTRACT_ID + ":");
console.table(stats);

const lastCandles = db.prepare(`SELECT timeframe, timestamp, close FROM candles WHERE symbol = ? ORDER BY id DESC LIMIT 5`).all(CONTRACT_ID);
console.log("\nLast 5 Candles added:");
console.table(lastCandles);
