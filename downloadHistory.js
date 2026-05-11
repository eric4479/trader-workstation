const axios = require('axios');
const { DateTime } = require('luxon');
const { getToken } = require('./auth');
const { API_ENDPOINT, CONTRACT_ID } = require('./config');
const { saveCandle } = require('./database');

const TIMEFRAMES = [
  { tf: '1m',  unit: 2, unitNumber: 1  },
  { tf: '5m',  unit: 2, unitNumber: 5  },
  { tf: '15m', unit: 2, unitNumber: 15 },
  { tf: '30m', unit: 2, unitNumber: 30 },
  { tf: '1h',  unit: 3, unitNumber: 1  },
  { tf: '4h',  unit: 3, unitNumber: 4  },
  { tf: '1d',  unit: 4, unitNumber: 1  },
];

async function fetchBars(token, timeframe, daysBack) {
  const endTime   = DateTime.utc();
  const startTime = endTime.minus({ days: daysBack });

  const payload = {
    contractId: CONTRACT_ID,
    live: false,
    startTime: startTime.toISO(),
    endTime:   endTime.toISO(),
    unit: timeframe.unit,
    unitNumber: timeframe.unitNumber,
    limit: 50000,
    includePartialBar: true
  };

  try {
    console.log(`  Fetching ${timeframe.tf} (${daysBack} days)…`);
    const res = await axios.post(`${API_ENDPOINT}/api/History/retrieveBars`, payload, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (res.data?.success && res.data.bars?.length) {
      const bars = res.data.bars;
      for (const bar of bars) {
        saveCandle({
          symbol: CONTRACT_ID,
          timeframe: timeframe.tf,
          timestamp: bar.t,
          open: bar.o, high: bar.h, low: bar.l, close: bar.c,
          volume: bar.v || 0
        });
      }
      console.log(`  ✓ ${bars.length} ${timeframe.tf} bars saved`);
    } else {
      console.log(`  ⚠ No data returned for ${timeframe.tf}: ${res.data?.errorMessage || 'empty'}`);
    }
  } catch (err) {
    console.error(`  ✗ ${timeframe.tf} error:`, err.response?.data || err.message);
  }
}

async function downloadHistory(daysBack = 30) {
  console.log(`\nDownloading ${daysBack} days of history for ${CONTRACT_ID}…`);
  const token = await getToken();

  for (const tf of TIMEFRAMES) {
    await fetchBars(token, tf, daysBack);
    await new Promise(r => setTimeout(r, 500)); // brief rate-limit pause
  }

  console.log('History download complete.\n');
}

if (require.main === module) {
  const days = parseInt(process.argv[2]) || 30;
  downloadHistory(days);
}

module.exports = { downloadHistory };
