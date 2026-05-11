const axios = require('axios');
const WebSocket = require('ws');
require('dotenv').config();

class SchwabConnector {
  constructor() {
    this.accessToken = null;
    this.streamerInfo = null;
    this.ws = null;
    this.onUpdateCallback = null;
    this.symbols = ['SPY', 'QQQ', 'VIX'];
    this.isConnected = false;
  }

  async authenticate() {
    if (!process.env.SCHWAB_REFRESH_TOKEN || !process.env.SCHWAB_APP_KEY) {
      console.warn('[SCHWAB] Missing keys in .env (SCHWAB_REFRESH_TOKEN, SCHWAB_APP_KEY)');
      return null;
    }

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', process.env.SCHWAB_REFRESH_TOKEN);
    
    const auth = Buffer.from(`${process.env.SCHWAB_APP_KEY}:${process.env.SCHWAB_APP_SECRET || ''}`).toString('base64');

    try {
      // Note: Schwab API endpoint might vary slightly based on final production docs
      const res = await axios.post('https://api.schwabapi.com/v1/oauth/token', params, {
        headers: { 
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      this.accessToken = res.data.access_token;
      return this.accessToken;
    } catch (err) {
      console.error('[SCHWAB] Auth failed:', err.response?.data || err.message);
      return null;
    }
  }

  async getStreamerInfo() {
    try {
      const res = await axios.get('https://api.schwabapi.com/v1/user/preference', {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      // The streamer info structure in Schwab API
      this.streamerInfo = res.data.streamerInfo; 
      return this.streamerInfo;
    } catch (err) {
      console.error('[SCHWAB] Failed to get streamer info:', err.message);
      return null;
    }
  }

  async start(onUpdate) {
    this.onUpdateCallback = onUpdate;
    const auth = await this.authenticate();
    if (!auth) return;

    const info = await this.getStreamerInfo();
    if (!info) return;

    this.ws = new WebSocket(info.streamerSocketUrl);

    this.ws.on('open', () => {
      console.log('[SCHWAB] Streamer Connected');
      this.login();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this.handleMessage(msg);
      } catch (e) {
        console.error('[SCHWAB] Parse Error:', e.message);
      }
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      console.log('[SCHWAB] Streamer Closed. Reconnecting in 5s...');
      setTimeout(() => this.start(onUpdate), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('[SCHWAB] WS Error:', err.message);
    });
  }

  login() {
    const loginReq = {
      requests: [{
        service: 'ADMIN',
        command: 'LOGIN',
        requestid: '1',
        account: this.streamerInfo.schwabClientCustomerId,
        parameters: {
          credential: this.streamerInfo.schwabClientToken,
          token: this.accessToken,
          appid: process.env.SCHWAB_APP_KEY
        }
      }]
    };
    this.ws.send(JSON.stringify(loginReq));
  }

  handleMessage(msg) {
    if (msg.response && msg.response[0].command === 'LOGIN' && msg.response[0].content.code === 0) {
      this.isConnected = true;
      console.log('[SCHWAB] Logged in successfully');
      this.subscribe();
    }

    if (msg.data) {
      msg.data.forEach(service => {
        if (service.service === 'LEVELONE_EQUITIES') {
          service.content.forEach(item => {
            if (this.onUpdateCallback) this.onUpdateCallback(item.key, item);
          });
        }
      });
    }
  }

  subscribe() {
    const subReq = {
      requests: [{
        service: 'LEVELONE_EQUITIES',
        command: 'SUBS',
        requestid: '2',
        account: this.streamerInfo.schwabClientCustomerId,
        parameters: {
          keys: this.symbols.join(','),
          fields: '0,1,2,3,4,5' // 0:key, 1:bid, 2:ask, 3:last, 4:vol
        }
      }]
    };
    this.ws.send(JSON.stringify(subReq));
  }
}

module.exports = new SchwabConnector();
