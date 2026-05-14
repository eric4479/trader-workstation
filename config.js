require('dotenv').config();

module.exports = {
  USERNAME: (process.env.PROJECT_X_USERNAME || "").replace(/['"]/g, '').trim(),
  API_KEY: (process.env.PROJECT_X_API_KEY || "").replace(/['"]/g, '').trim(),

  API_ENDPOINT: (process.env.API_ENDPOINT || "https://api.topstepx.com").replace(/['"]/g, '').trim(),
  MARKET_HUB: (process.env.MARKET_HUB || "https://rtc.topstepx.com/hubs/market").replace(/['"]/g, '').trim(),

  CONTRACT_ID: (process.env.CONTRACT_ID || "CON.F.US.MNQ.M26").replace(/['"]/g, '').trim()
};
