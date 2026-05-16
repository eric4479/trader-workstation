require('dotenv').config();

function cleanEnv(value, fallback = '') {
  return (value || fallback).replace(/["']/g, '').trim();
}

function isConfigured(value) {
  return Boolean(value && !/^your_|_here$/i.test(value) && value !== 'your_api_key_here');
}

const USERNAME = cleanEnv(process.env.PROJECT_X_USERNAME);
const API_KEY = cleanEnv(process.env.PROJECT_X_API_KEY);
const CONTRACT_ID = cleanEnv(process.env.CONTRACT_ID, 'CON.F.US.MNQ.M26');
const DATA_PROVIDER = cleanEnv(process.env.DATA_PROVIDER, 'auto').toLowerCase();

module.exports = {
  USERNAME,
  API_KEY,
  API_ENDPOINT: cleanEnv(process.env.API_ENDPOINT, 'https://api.topstepx.com'),
  MARKET_HUB: cleanEnv(process.env.MARKET_HUB, 'https://rtc.topstepx.com/hubs/market'),
  CONTRACT_ID,
  DATA_PROVIDER,
  TOPSTEP_ENABLED: DATA_PROVIDER !== 'schwab' && isConfigured(USERNAME) && isConfigured(API_KEY),
  SCHWAB_ENABLED: DATA_PROVIDER !== 'topstepx'
};
