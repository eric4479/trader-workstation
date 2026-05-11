const axios = require('axios');
const { DateTime } = require('luxon');
require('dotenv').config();

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

const SYMBOLS = {
  VIX: 'VIX',
  SPY: 'SPY',
  QQQ: 'QQQ',
  IWM: 'IWM',
  DXY: 'UUP', // Proxy for Dollar Index
};

async function getMarketInternals() {
  if (!FINNHUB_KEY) return null;
  
  const results = {};
  try {
    const promises = Object.entries(SYMBOLS).map(async ([name, symbol]) => {
      const res = await axios.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`);
      results[name] = {
        price: res.data.c,
        change: res.data.dp,
        high: res.data.h,
        low: res.data.l
      };
    });
    
    await Promise.all(promises);
    return results;
  } catch (err) {
    console.error('[INTERNALS] Error fetching market data:', err.message);
    return null;
  }
}

async function getEconomicCalendar() {
  if (!FINNHUB_KEY) return [];
  
  try {
    const today = DateTime.now().toISODate();
    const res = await axios.get(`https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${today}&token=${FINNHUB_KEY}`);
    
    // Filter for high impact news (impact: 'high')
    const highImpact = res.data.economicCalendar
      .filter(event => event.impact === 'high')
      .map(event => ({
        time: event.time,
        event: event.event,
        country: event.country,
        prev: event.prev,
        estimate: event.estimate
      }));
      
    return highImpact;
  } catch (err) {
    console.error('[CALENDAR] Error fetching news:', err.message);
    return [];
  }
}

module.exports = { getMarketInternals, getEconomicCalendar };
