const axios = require('axios');
const WebSocket = require('ws');
require('dotenv').config();

// Numeric field → named key maps (per Schwab Streamer field tables)
const EQUITY_FIELDS = {
  0: 'symbol', 1: 'bid', 2: 'ask', 3: 'last', 4: 'bidSize', 5: 'askSize',
  8: 'volume', 10: 'high', 11: 'low', 17: 'open', 18: 'netChange',
  33: 'mark', 42: 'netChangePct'
};

// LEVELONE_FUTURES field numbers differ from equities (separate table)
const FUTURES_FIELDS = {
  0: 'symbol', 1: 'bid', 2: 'ask', 3: 'last', 4: 'bidSize', 5: 'askSize',
  8: 'volume', 12: 'high', 13: 'low', 18: 'open', 19: 'netChange',
  20: 'netChangePct', 23: 'openInterest', 33: 'settlementPrice'
};

const FOREX_FIELDS = {
  0: 'symbol', 1: 'bid', 2: 'ask', 3: 'last', 4: 'bidSize', 5: 'askSize'
};

// Market internals ($TICK/$ADD/$TRIN/$VOLD) require an entitled Schwab brokerage
// account — run Phase 0 validation first to confirm these symbols stream for you.
const EQUITY_SYMBOLS = [
  'SPY', 'QQQ', 'IWM', 'DIA', 'UUP',
  '$VIX.X', '$TICK', '$ADD', '$TRIN', '$VOLD',
  '$TICK/Q', '$ADD/Q', '$TRIN/Q', '$VOLD/Q',
  'XLK', 'XLF', 'XLE', 'XLY', 'XLP', 'XLV', 'XLI', 'XLU', 'XLB', 'XLRE', 'XLC'
];

// Continuous front-month futures for context (quotes only, no REST bars)
const FUTURES_SYMBOLS = ['/ES', '/NQ', '/MNQ', '/MES', '/M2K', '/CL', '/GC', '/ZN'];

// Forex basket for synthetic DXY; no native $DXY symbol on the Schwab streamer
const FOREX_SYMBOLS = ['USD/JPY', 'USD/EUR', 'USD/GBP', 'USD/CHF', 'USD/CAD'];

function decodeFields(item, fieldMap) {
  const decoded = {};
  for (const [num, name] of Object.entries(fieldMap)) {
    if (item[num] !== undefined) decoded[name] = item[num];
  }
  // key is always the symbol identifier
  if (item.key) decoded.symbol = item.key;
  return decoded;
}

class SchwabConnector {
  constructor() {
    this.accessToken = null;
    this.streamerInfo = null;
    this.ws = null;
    this.onUpdateCallback = null;
    this.isConnected = false;
    this._refreshTimer = null;
  }

  hasCredentials() {
    return Boolean(process.env.SCHWAB_REFRESH_TOKEN && process.env.SCHWAB_APP_KEY);
  }

  async authenticate() {
    if (!this.hasCredentials()) {
      console.warn('[SCHWAB] Missing SCHWAB_REFRESH_TOKEN / SCHWAB_APP_KEY in .env — optional Schwab stream disabled');
      return null;
    }

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', process.env.SCHWAB_REFRESH_TOKEN);

    const auth = Buffer.from(
      `${process.env.SCHWAB_APP_KEY}:${process.env.SCHWAB_APP_SECRET || ''}`
    ).toString('base64');

    try {
      const res = await axios.post('https://api.schwabapi.com/v1/oauth/token', params, {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      this.accessToken = res.data.access_token;
      console.log('[SCHWAB] Access token refreshed');

      // Schwab access tokens expire after 30 min; refresh every 25 min
      if (this._refreshTimer) clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => this.authenticate(), 25 * 60 * 1000);

      return this.accessToken;
    } catch (err) {
      console.error('[SCHWAB] Auth failed:', err.response?.data || err.message);
      return null;
    }
  }

  async getStreamerInfo() {
    try {
      // Correct Schwab endpoint (not /v1/user/preference)
      const res = await axios.get('https://api.schwabapi.com/trader/v1/userPreference', {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      // streamerInfo is returned as an array; use the first entry
      const info = Array.isArray(res.data.streamerInfo)
        ? res.data.streamerInfo[0]
        : res.data.streamerInfo;
      this.streamerInfo = info;
      return info;
    } catch (err) {
      console.error('[SCHWAB] Failed to get streamer info:', err.message);
      return null;
    }
  }

  async start(onUpdate) {
    this.onUpdateCallback = onUpdate;
    const token = await this.authenticate();
    if (!token) {
      if (this.hasCredentials()) {
        // Transient auth failure (e.g. network blip) — retry after 5 s
        setTimeout(() => this.start(onUpdate), 5000);
      }
      return;
    }

    const info = await this.getStreamerInfo();
    if (!info) return;

    this.ws = new WebSocket(info.streamerSocketUrl);

    this.ws.on('open', () => {
      console.log('[SCHWAB] WebSocket connected');
      this._login();
    });

    this.ws.on('message', (raw) => {
      try {
        this._handleMessage(JSON.parse(raw));
      } catch (e) {
        console.error('[SCHWAB] Parse error:', e.message);
      }
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      console.log('[SCHWAB] Connection closed — reconnecting in 5s');
      setTimeout(() => this.start(onUpdate), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('[SCHWAB] WS error:', err.message);
    });
  }

  _login() {
    const info = this.streamerInfo;
    // Schwab streamer login — token is passed as plain string (no "Bearer " prefix)
    const req = {
      requests: [{
        service: 'ADMIN',
        requestid: '0',
        command: 'LOGIN',
        account: info.schwabClientCustomerId,
        source: process.env.SCHWAB_APP_KEY,
        parameters: {
          Authorization: this.accessToken,
          SchwabClientChannel: info.SchwabClientChannel ?? info.schwabClientChannel,
          SchwabClientFunctionId: info.SchwabClientFunctionId ?? info.schwabClientFunctionId
        }
      }]
    };
    this.ws.send(JSON.stringify(req));
  }

  _subscribe() {
    const acct = this.streamerInfo.schwabClientCustomerId;
    const src  = process.env.SCHWAB_APP_KEY;

    const requests = [
      {
        service: 'LEVELONE_EQUITIES',
        command: 'SUBS',
        requestid: '1',
        account: acct,
        source: src,
        parameters: {
          keys: EQUITY_SYMBOLS.join(','),
          fields: Object.keys(EQUITY_FIELDS).join(',')
        }
      },
      {
        service: 'LEVELONE_FUTURES',
        command: 'SUBS',
        requestid: '2',
        account: acct,
        source: src,
        parameters: {
          keys: FUTURES_SYMBOLS.join(','),
          fields: Object.keys(FUTURES_FIELDS).join(',')
        }
      },
      {
        service: 'LEVELONE_FOREX',
        command: 'SUBS',
        requestid: '3',
        account: acct,
        source: src,
        parameters: {
          keys: FOREX_SYMBOLS.join(','),
          fields: Object.keys(FOREX_FIELDS).join(',')
        }
      }
    ];

    this.ws.send(JSON.stringify({ requests }));
    console.log('[SCHWAB] Subscribed: equities, futures, forex');
  }

  _handleMessage(msg) {
    // Login / command responses
    if (msg.response) {
      for (const resp of msg.response) {
        if (resp.command === 'LOGIN') {
          if (resp.content?.code === 0) {
            this.isConnected = true;
            console.log('[SCHWAB] Authenticated — subscribing streams');
            this._subscribe();
          } else {
            console.error('[SCHWAB] Login rejected:', resp.content);
          }
        }
        // Code 12 = server closed due to duplicate connection
        if (resp.content?.code === 12) {
          console.warn('[SCHWAB] Kicked by server (code 12 — duplicate WebSocket session)');
        }
      }
    }

    // Market data
    if (msg.data) {
      for (const service of msg.data) {
        const svc = service.service;
        const fieldMap =
          svc === 'LEVELONE_EQUITIES' ? EQUITY_FIELDS  :
          svc === 'LEVELONE_FUTURES'  ? FUTURES_FIELDS :
          svc === 'LEVELONE_FOREX'    ? FOREX_FIELDS   : null;

        if (!fieldMap || !this.onUpdateCallback) continue;

        for (const item of service.content) {
          const decoded = decodeFields(item, fieldMap);
          this.onUpdateCallback(svc, item.key, decoded);
        }
      }
    }
  }
}

module.exports = new SchwabConnector();
