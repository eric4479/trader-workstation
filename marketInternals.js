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
  if (!FINNHUB_KEY) return { status: 'OFFLINE', data: null };
  
  const results = { status: 'ACTIVE', data: {} };
  try {
    const promises = Object.entries(SYMBOLS).map(async ([name, symbol]) => {
      const res = await axios.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`);
      if (!res.data || res.data.c === 0) {
        throw new Error(`Invalid data for ${symbol}`);
      }
      results.data[name] = {
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
    return { status: 'ERROR', data: null, error: err.message };
  }
}

async function getEconomicCalendar() {
  if (!FINNHUB_KEY) return { status: 'OFFLINE', data: [] };
  
  try {
    const today = DateTime.now().toISODate();
    const res = await axios.get(`https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${today}&token=${FINNHUB_KEY}`);
    
    if (!res.data || !res.data.economicCalendar) {
       return { status: 'ACTIVE', data: [] };
    }

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
      
    return { status: 'ACTIVE', data: highImpact };
  } catch (err) {
    console.error('[CALENDAR] Error fetching news:', err.message);
    return { status: 'ERROR', data: [], error: err.message };
  }
}

module.exports = { getMarketInternals, getEconomicCalendar };
