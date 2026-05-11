const { MACD, RSI, ATR, Stochastic } = require('trading-signals');
const macd = new MACD({ indicator: require('trading-signals').EMA, shortInterval: 12, longInterval: 26, signalInterval: 9 });
console.log(macd.isStable);
