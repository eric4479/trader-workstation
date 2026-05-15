const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { execFileSync } = require('child_process');
const { db, savePaperOrder, getPaperOrders, getAlgoStatsDetailed, getAllSignals, getDailyPnL } = require('./database');
const { runBacktest } = require('./backtestEngine');
const { CONTRACT_ID } = require('./config');

function getBars(timeframe, limit = 1000) {
  const rows = db.prepare(`
    SELECT * FROM candles
    WHERE symbol = ? AND timeframe = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(CONTRACT_ID, timeframe, limit);
  return rows.reverse();
}

function getSessionLevels() {
  const today = new Date().toISOString().split('T')[0];
  
  // Get Prior Day Stats
  const priorDay = db.prepare(`
    SELECT * FROM session_stats 
    WHERE symbol = ? AND date < ?
    ORDER BY date DESC LIMIT 1
  `).get(CONTRACT_ID, today);

  // Get Current Day Stats (if any yet)
  const currentDay = db.prepare(`
    SELECT * FROM session_stats 
    WHERE symbol = ? AND date = ?
  `).get(CONTRACT_ID, today);

  const lastCandle = db.prepare(`
    SELECT * FROM candles WHERE symbol = ? AND timeframe = '1d'
    ORDER BY timestamp DESC LIMIT 1
  `).get(CONTRACT_ID);

  let pivots = null;
  if (lastCandle) {
    const p = (lastCandle.high + lastCandle.low + lastCandle.close) / 3;
    pivots = {
      pivot: p,
      r1: 2 * p - lastCandle.low,
      s1: 2 * p - lastCandle.high,
      r2: p + (lastCandle.high - lastCandle.low),
      s2: p - (lastCandle.high - lastCandle.low)
    };
  }

  return {
    pivots,
    priorDay,
    currentDay,
    orb1: currentDay ? { high: currentDay.orb1_high, low: currentDay.orb1_low } : null,
    orb5: currentDay ? { high: currentDay.orb5_high, low: currentDay.orb5_low } : null,
    orb15: currentDay ? { high: currentDay.orb15_high, low: currentDay.orb15_low } : null
  };
}

function startDashboard(onReady) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.use(express.json());
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/pro.html'));
  });

  app.use(express.static(path.join(__dirname)));

  app.get('/v1', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  app.get('/v2', (req, res) => {
    res.sendFile(path.join(__dirname, 'v2.html'));
  });

  app.get('/proto_tabs', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/proto_tabs.html'));
  });

  app.get('/proto_terminal', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/proto_terminal.html'));
  });

  app.get('/api/scanner', (req, res) => {
    try {
      const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32'
        ? path.join(__dirname, 'venv', 'Scripts', 'python.exe')
        : path.join(__dirname, 'venv', 'bin', 'python3'));
      const output = execFileSync(pythonBin, [path.join(__dirname, 'scanner.py')], {
        cwd: __dirname,
        timeout: 30000,
        encoding: 'utf8',
        env: { ...process.env }
      });
      res.json({ success: true, output });
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : '';
      res.status(500).json({ success: false, error: err.message, stderr });
    }
  });

  app.get('/api/candles', (req, res) => {
    const tf = req.query.tf || '1m';
    const limit = parseInt(req.query.limit) || 1000;
    res.json(getBars(tf, limit));
  });

  app.post('/api/paper/order', (req, res) => {
    const side = String(req.body.side || '').toUpperCase();
    const price = Number(req.body.price);
    const quantity = Number.parseInt(req.body.quantity, 10);
    const stopLoss = req.body.stop_loss === undefined ? null : Number(req.body.stop_loss);
    const takeProfit = req.body.take_profit === undefined ? null : Number(req.body.take_profit);

    if (!['BUY', 'SELL'].includes(side)) {
      return res.status(400).json({ success: false, error: 'side must be BUY or SELL' });
    }
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, error: 'price must be a positive number' });
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ success: false, error: 'quantity must be a positive integer' });
    }
    if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) {
      return res.status(400).json({ success: false, error: 'stop_loss and take_profit are required numeric bracket levels' });
    }
    if (side === 'BUY' && !(stopLoss < price && takeProfit > price)) {
      return res.status(400).json({ success: false, error: 'BUY orders require stop_loss below price and take_profit above price' });
    }
    if (side === 'SELL' && !(stopLoss > price && takeProfit < price)) {
      return res.status(400).json({ success: false, error: 'SELL orders require stop_loss above price and take_profit below price' });
    }

    const order = {
      symbol: CONTRACT_ID,
      side,
      price,
      quantity,
      signal_id: req.body.signal_id || null,
      stop_loss: stopLoss,
      take_profit: takeProfit
    };
    const result = savePaperOrder(order);
    const savedOrder = { id: result.lastInsertRowid, status: 'OPEN', ...order };
    res.json({ success: true, order: savedOrder });
    io.emit('order_update', getPaperOrders());
  });

  app.get('/api/paper/orders', (req, res) => {
    res.json(getPaperOrders());
  });

  app.get('/api/signals', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(getAllSignals(CONTRACT_ID, limit));
  });


  app.get('/api/backtest', (req, res) => {
    try {
      const report = runBacktest({
        symbols: req.query.symbols || req.query.symbol,
        orMinutes: req.query.or || req.query.orMinutes,
        targetPoints: req.query.target,
        stopPoints: req.query.stop,
        quantity: req.query.quantity,
        limit: req.query.limit,
        sweep: req.query.sweep
      });
      res.json({ success: true, ...report });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/analytics', (req, res) => {
    res.json({
      leaderboard: getAlgoStatsDetailed(CONTRACT_ID),
      dailyPnL: getDailyPnL(CONTRACT_ID)
    });
  });

  io.on('connection', (socket) => {
    socket.emit('levels', getSessionLevels());
    socket.emit('order_update', getPaperOrders());
    socket.emit('analytics', {
      leaderboard: getAlgoStatsDetailed(CONTRACT_ID),
      dailyPnL: getDailyPnL(CONTRACT_ID),
      signals: getAllSignals(CONTRACT_ID, 30)
    });
  });

  const PORT = 3000;
  server.listen(PORT, () => {
    console.log(`Dashboard active at http://localhost:${PORT}`);
    if (onReady) onReady(io);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use. Run 'fuser -k ${PORT}/tcp' or restart the engine.`);
      process.exit(1);
    } else {
      throw err;
    }
  });

  return io;
}

module.exports = { startDashboard };
