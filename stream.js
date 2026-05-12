const { HubConnectionBuilder, HttpTransportType } = require("@microsoft/signalr");
const { MARKET_HUB, CONTRACT_ID } = require("./config");
const { updateCandles, timeState, tickState } = require("./candleEngine");
const { saveTrade } = require("./database");

// DomType enum from ProjectX documentation
const DomType = {
  Unknown: 0, Ask: 1, Bid: 2, BestAsk: 3, BestBid: 4,
  Trade: 5, Reset: 6, Low: 7, High: 8,
  NewBestBid: 9, NewBestAsk: 10, Fill: 11
};

// DOM state — GatewayDepth sends delta updates, not snapshots; we maintain
// last-known volume per price level and apply Reset events as full clears.
const domState = {
  bids: {}, // price -> volume
  asks: {}  // price -> volume
};

function applyDepthDelta(data) {
  const { type, price, volume } = data;

  if (type === DomType.Reset) {
    domState.bids = {};
    domState.asks = {};
    return;
  }

  if (type === DomType.Bid || type === DomType.BestBid || type === DomType.NewBestBid) {
    if (volume === 0) {
      delete domState.bids[price];
    } else {
      domState.bids[price] = volume;
    }
  } else if (type === DomType.Ask || type === DomType.BestAsk || type === DomType.NewBestAsk) {
    if (volume === 0) {
      delete domState.asks[price];
    } else {
      domState.asks[price] = volume;
    }
  }
}

function getTopOfBook(levels = 10) {
  const sortedBids = Object.entries(domState.bids)
    .map(([p, v]) => ({ price: Number(p), volume: v }))
    .sort((a, b) => b.price - a.price)
    .slice(0, levels);
  const sortedAsks = Object.entries(domState.asks)
    .map(([p, v]) => ({ price: Number(p), volume: v }))
    .sort((a, b) => a.price - b.price)
    .slice(0, levels);
  return { bids: sortedBids, asks: sortedAsks };
}

async function resubscribe(connection) {
  await connection.invoke("SubscribeContractTrades", CONTRACT_ID);
  await connection.invoke("SubscribeContractQuotes", CONTRACT_ID);
  await connection.invoke("SubscribeContractDepth", CONTRACT_ID);
}

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
        for (const tf of ['1m', '5m', '15m', '30m', '1h']) {
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
      onUpdate({
        type: 'quote',
        bid: data.bestBid ?? data.bidPrice,
        bidSize: data.bidSize,
        ask: data.bestAsk ?? data.askPrice,
        askSize: data.askSize,
        lastPrice: data.lastPrice,
        volume: data.volume,
        high: data.high,
        low: data.low,
        open: data.open,
        change: data.change,
        changePercent: data.changePercent,
        indicators
      });
    }
  });

  // GatewaySummary is NOT emitted by the ProjectX market hub; summary-style
  // data (open/high/low/volume/change) is included in GatewayQuote payloads.

  // Debounce DOM emissions: apply every delta immediately (O(1) map update)
  // but only sort+emit once per 100 ms window to avoid O(N log N) sort on
  // every high-frequency depth tick.
  let domFlushTimer = null;
  function scheduleDomFlush() {
    if (domFlushTimer || !onUpdate) return;
    domFlushTimer = setTimeout(() => {
      domFlushTimer = null;
      onUpdate({ type: 'depth', dom: getTopOfBook(10) });
    }, 100);
  }

  connection.on("GatewayDepth", (contractId, data) => {
    if (!data) return;
    const events = Array.isArray(data) ? data : [data];
    events.forEach(applyDepthDelta);
    scheduleDomFlush();
  });

  connection.onclose(() => console.log("[STREAM] SignalR disconnected"));
  connection.onreconnecting(() => console.log("[STREAM] SignalR reconnecting…"));
  connection.onreconnected(async () => {
    console.log("[STREAM] Reconnected — resubscribing all channels");
    // DOM state is now stale; clear it so we start fresh from the next Reset event
    domState.bids = {};
    domState.asks = {};
    await resubscribe(connection);
  });

  try {
    await connection.start();
    console.log("[STREAM] Connected to TopstepX SignalR market hub");
    await resubscribe(connection);
    console.log(`[STREAM] Subscribed to Trades, Quotes, Depth for ${CONTRACT_ID}`);
  } catch (err) {
    console.error("[STREAM] SignalR error:", err.message);
  }
}

module.exports = { startStream };
