const { HubConnectionBuilder, HttpTransportType } = require("@microsoft/signalr");
const { MARKET_HUB, CONTRACT_ID } = require("./config");
const { updateCandles, timeState, tickState } = require("./candleEngine");
const { saveTrade } = require("./database");

async function startStream(token, onUpdate) {
  const connection = new HubConnectionBuilder()
    .withUrl(`${MARKET_HUB}?access_token=${token}`, {
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
      accessTokenFactory: () => token
    })
    .withAutomaticReconnect()
    .build();

  connection.on("GatewayTrade", (contractId, data) => {
    if (!data) return;
    const trades = Array.isArray(data) ? data : [data];

    trades.forEach(trade => {
      const price = trade.price ?? trade.p;
      const size  = trade.size  ?? trade.v ?? 1;
      const ts    = trade.timestamp ?? trade.t ?? new Date().toISOString();
      if (!price) return;

      saveTrade({ symbol: contractId, timestamp: ts, price, size, side: trade.side });

      const { timeState: ts2, tickState: tick, closedTickBars, indicators } = updateCandles(contractId, { ...trade, type: 'trade' });

      if (onUpdate) {
        const bars = {};
        for (const tf of ['1m','5m','15m','30m','1h','4h','1d']) {
          const key = `${contractId}_${tf}`;
          if (ts2[key]) {
            const latestKey = Object.keys(ts2[key]).sort().pop();
            bars[tf] = ts2[key][latestKey];
          }
        }
        const tickBars = {};
        for (const sz of [100, 500, 1000]) {
          const key = `${contractId}_${sz}t`;
          if (tick[key]) tickBars[`${sz}t`] = tick[key];
        }

        onUpdate({ type: 'trade', price, size, ts, bars, tickBars, closedTickBars, indicators });
      }
    });
  });

  connection.on("GatewayQuote", (contractId, data) => {
    if (!data) return;
    const { indicators } = updateCandles(contractId, { ...data, type: 'quote' });
    if (onUpdate) {
      onUpdate({ type: 'quote', bid: data.bidPrice, bidSize: data.bidSize, ask: data.askPrice, askSize: data.askSize, indicators });
    }
  });

  connection.on("GatewaySummary", (contractId, data) => {
    if (!data) return;
    const { indicators } = updateCandles(contractId, { ...data, type: 'summary' });
    if (onUpdate) {
      onUpdate({ type: 'summary', summary: data, indicators });
    }
  });

  connection.onclose(() => console.log("SignalR disconnected"));
  connection.onreconnecting(() => console.log("SignalR reconnecting…"));
  connection.onreconnected(() => {
    console.log("Reconnected — resubscribing");
    connection.invoke("SubscribeContractTrades", CONTRACT_ID);
    connection.invoke("SubscribeContractQuotes", CONTRACT_ID);
  });

  try {
    await connection.start();
    console.log("Connected to TopstepX SignalR");
    await connection.invoke("SubscribeContractTrades", CONTRACT_ID);
    await connection.invoke("SubscribeContractQuotes", CONTRACT_ID);
    console.log(`Subscribed to Trades and Quotes for ${CONTRACT_ID}`);
  } catch (err) {
    console.error("SignalR error:", err.message);
  }
}

module.exports = { startStream };
