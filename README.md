# 🖥 Elite MNQ Trader Workstation

A professional-grade, real-time trading terminal for **Micro E-mini Nasdaq-100 (MNQ)** futures.  
Uses **Schwab** for market context when configured and **TopstepX (ProjectX)** for the live futures tick stream when credentials are available, runs multi-algorithm signal detection, and surfaces everything through a dark-mode dashboard with WebSocket updates.

---

## 🚀 Quick Start (Recommended)

```bash
# 1. Clone / navigate to the project
cd ~/projects/trader-workstation

# 2. Copy environment config and fill in your API keys
cp .env.example .env
nano .env        # or code .env / vim .env

# 3. Run the easy-start launcher
./start.sh
```

The interactive launcher will install dependencies, set up the Python environment, and let you choose what to run.

---

## ⚙️ Prerequisites

| Requirement | Minimum Version | Install |
|---|---|---|
| **Node.js** | v18+ | https://nodejs.org |
| **npm** | v9+ | bundled with Node |
| **Python 3** | v3.10+ | https://python.org |
| **pip** | v22+ | bundled with Python |
| **SQLite** | v3.35+ | pre-installed on macOS/Linux |

---

## 🔑 Environment Configuration (`.env`)

Copy `.env.example` to `.env` and populate every field:

```dotenv
# ── Data provider mode ──────────────────────────────────────
# auto = Schwab context + TopstepX futures stream when credentials are available
DATA_PROVIDER=auto

# ── TopstepX / ProjectX ─────────────────────────────────────
PROJECT_X_API_KEY=your_api_key_here        # From https://dashboard.projectx.com/
PROJECT_X_USERNAME=your_username_here
PROJECT_X_ACCOUNT_ID=your_account_id_here

# ── Active Contract ──────────────────────────────────────────
# Format: CON.F.US.MNQ.{month}{year}
# Month codes: H=Mar  M=Jun  U=Sep  Z=Dec
CONTRACT_ID=CON.F.US.MNQ.M26              # June 2026 MNQ

# ── API Endpoints (do not change) ───────────────────────────
API_ENDPOINT=https://api.topstepx.com
MARKET_HUB=https://rtc.topstepx.com/hubs/market

# ── Optional: Finnhub supplemental market data ──────────────
# FINNHUB_API_KEY=your_key_here
```

> **Contract Roll reminder:** Update `CONTRACT_ID` every quarter when the futures contract expires.  
> Run `npm run find-contract` to list available contracts.

---

## 📋 All Commands

### Interactive Launcher
```bash
./start.sh          # Presents a numbered menu — recommended for daily use
```

### `npm` Scripts (non-interactive)

| Command | Description |
|---|---|
| `npm start` | Full engine — live price stream + strategy signals + dashboard |
| `npm run dev` | Same as start (alias) |
| `npm run dashboard` | Dashboard UI only — no live stream, reads cached DB data |
| `npm run history` | Download 30 days of OHLCV bars from TopstepX |
| `npm run history:90` | Download 90 days of OHLCV bars |
| `npm run scanner` | Python Z-score / Kelly opportunity scanner |
| `npm run backtest` | Run ORB backtests and rank symbols/parameters by expectancy |
| `npm run monte-carlo` | Python Monte Carlo risk simulation |
| `npm run check-db` | Print candle counts & 5 latest bars from the database |
| `npm run find-contract` | Query TopstepX for available MNQ contract IDs |
| `npm run setup` | Set up the Python virtual environment (one-time) |

### Direct `node` Commands

```bash
# Start the full engine
node index.js

# Download a custom number of days of history
node downloadHistory.js 60        # 60 days

# Check database statistics
node check_db.js

# Find current contract IDs on TopstepX
node find_contract.js
```

### Python Commands (activate venv first)

```bash
# Activate virtual environment
source venv/bin/activate

# Run the market opportunity scanner
python3 scanner.py

# Run the Monte Carlo risk simulation
python3 monte_carlo.py

# Deactivate when done
deactivate
```

---

## 🗂 Project File Map

```
trader-workstation/
│
├── 📄 index.js              — Main engine: auth → stream → signal eval → dashboard push
├── 📄 dashboard.js          — Express + Socket.io server (port 3000)
├── 📄 index.html            — Dark-mode trading dashboard UI (served statically)
│
├── 📄 auth.js               — TopstepX JWT authentication
├── 📄 stream.js             — SignalR market data websocket client
├── 📄 candleEngine.js       — OHLCV candle builder (tick → 1m/5m bars)
├── 📄 strategyEngine.js     — Multi-algo signal engine (Mean Rev, ORB, EMA, Volume)
├── 📄 analyzeORB.js         — Legacy Opening Range Breakout detector
├── 📄 backtestEngine.js     — Parameterized ORB backtester with EV/Kelly ranking
│
├── 📄 database.js           — SQLite schema, candle CRUD, signals, paper orders
├── 📄 downloadHistory.js    — Bulk historical bar downloader (all timeframes)
├── 📄 check_db.js           — Quick DB health-check script
├── 📄 find_contract.js      — Lists available futures contracts from the API
│
├── 🐍 scanner.py            — Python market scanner (Z-score, ATR, Kelly sizing)
├── 🐍 monte_carlo.py        — Monte Carlo equity-curve simulation
│
├── 📄 config.js             — Reads CONTRACT_ID and API endpoints from .env
├── 📄 package.json          — Node.js dependencies and npm scripts
├── 📄 requirements.txt      — Python dependencies (pandas, numpy)
├── 📄 setup_venv.sh         — One-time Python venv installer
│
├── 📄 .env                  — ⚠ Private API keys (never commit to git)
├── 📄 .env.example          — Safe template — commit this
│
└── 🗄  trading_data.db      — SQLite database (candles, signals, paper orders)
```

---

## 🧠 Architecture Overview

```
TopstepX API (SignalR WebSocket)
        │
        ▼
   stream.js  ──tick events──▶  candleEngine.js  ──builds──▶  SQLite DB
                                                                    │
   index.js  ◀──────────────────────────────────────────── bars
        │
        ├──▶  strategyEngine.js  (Mean Reversion · ORB · EMA · Volume Breakout)
        │            └── generates signals ──▶ DB (strategy_signals table)
        │
        └──▶  dashboard.js (Express / Socket.io)
                    └──▶  index.html  ◀──  Browser @ http://localhost:3000
```

**Data flows one-way:** market data → candle storage → strategy evaluation → UI push via WebSocket.

---

## 📈 Trading Strategies

| Strategy | Trigger | Side |
|---|---|---|
| **Mean Reversion** | Z-score > ±2.0 vs 50-period EMA | Counter-trend |
| **ORB Breakout** | Price exceeds opening-range high/low | With trend |
| **EMA Crossover** | Fast EMA crosses Slow EMA | With trend |
| **Volume Breakout** | Bollinger Band expansion + vol > 150% avg | With trend |
| **80% Rule** | Price re-enters prior Value Area | With trend |

Signal ranking uses **Expected Value (EV)** and **Kelly Criterion** — tracked in the leaderboard.

---

## 🖥 Dashboard API Endpoints

The dashboard server exposes a REST API at `http://localhost:3000`:

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Main trading dashboard UI |
| `/api/candles?tf=1m&limit=500` | GET | OHLCV candles for charting |
| `/api/signals?limit=50` | GET | Recent strategy signals |
| `/api/analytics` | GET | Leaderboard stats + daily P&L |
| `/api/backtest?symbols=CON.F.US.MNQ.M26&or=15&target=20&stop=10` | GET | Run ORB backtests and return EV/Kelly-ranked results |
| `/api/paper/orders` | GET | All paper trade orders |
| `/api/paper/order` | POST | Place a paper trade manually |

**Socket.io Events** (real-time):

| Event | Direction | Payload |
|---|---|---|
| `tick` | Server → Client | price, bars, indicators, signals, leaderboard |
| `levels` | Server → Client | pivot points, S/R levels |
| `order_update` | Server → Client | updated paper order list |
| `analytics` | Server → Client | leaderboard + daily P&L + signals |

---

## 🗄 Database Schema (SQLite)

**`candles`** — OHLCV bars for every timeframe  
**`strategy_signals`** — Signal log with algo name, side, entry, target, stop, outcome  
**`paper_orders`** — Manual and auto paper trade records  

```bash
# Inspect the database from the command line
sqlite3 trading_data.db ".tables"
sqlite3 trading_data.db "SELECT timeframe, count(*) FROM candles GROUP BY timeframe;"
```

---

## 🧪 Backtesting

Run the built-in ORB backtester against stored 1-minute candles. Results include trade counts, win rate, expectancy in points, P&L using inferred futures point values, max drawdown, profit factor, Sharpe-like score, and Kelly fraction.

```bash
npm run backtest -- --symbols=CON.F.US.MNQ.M26 --or=15 --target=20 --stop=10
```

Use `--sweep=true` to rank an ORB parameter matrix, or call the dashboard API for programmatic ranking:

```bash
curl 'http://localhost:3000/api/backtest?symbols=CON.F.US.MNQ.M26&sweep=true&or=1,5,15&target=10,20,30&stop=10,15'
```

---

## 🐍 Python Tools

### Market Scanner (`scanner.py`)
Reads the local SQLite database and computes:
- **Z-Score** — How many standard deviations price is from its 50-period mean
- **ATR** — 14-period average true range for volatility context
- **Kelly Criterion** — Optimal risk fraction given a win-rate and R/R ratio

```bash
source venv/bin/activate
python3 scanner.py
```

### Monte Carlo Simulation (`monte_carlo.py`)
Simulates thousands of equity-curve paths to stress-test risk parameters.

```bash
source venv/bin/activate
python3 monte_carlo.py
```

---

## 🔧 One-Time Setup (Manual)

If you prefer not to use `./start.sh`:

```bash
# 1. Install Node.js dependencies
npm install

# 2. Set up Python virtual environment
bash setup_venv.sh

# 3. Configure environment
cp .env.example .env
# Edit .env with your TopstepX credentials

# 4. Download historical data (builds the local DB)
npm run history

# 5. Start the engine
npm start
```

---

## 🩺 Troubleshooting

| Problem | Fix |
|---|---|
| `Port 3000 already in use` | Run `fuser -k 3000/tcp` then retry |
| `Authentication failed` | Check `PROJECT_X_API_KEY` in `.env` |
| `No data in database` | Run `npm run history` first |
| Python `ModuleNotFoundError` | Run `bash setup_venv.sh` to recreate the venv |
| `CONTRACT_ID not found` | Run `npm run find-contract` to get valid IDs |
| SignalR disconnects frequently | TopstepX may throttle; the stream auto-reconnects |

---

## 📚 Resources & References

| Resource | URL |
|---|---|
| TopstepX Dashboard | https://dashboard.projectx.com/ |
| ProjectX API Docs | https://gateway.docs.projectx.com/docs/intro |
| Node TALib (indicators) | https://github.com/oransel/node-talib |
| trading-signals (npm) | https://www.npmjs.com/package/trading-signals |
| SMB Training Strategies | https://smbtraining.com/cheatsheets |
| Finnhub Market Data | https://finnhub.io/dashboard |
| MNQ Contract Specs | https://www.cmegroup.com/markets/equities/nasdaq/micro-e-mini-nasdaq-100.html |

---

## ⚠️ Risk Disclaimer

This software is for **educational and research purposes only**.  
Futures trading involves substantial risk of loss. Always use proper position sizing and never risk more than you can afford to lose. This system is not financial advice.

---

> Built with Node.js · Express · Socket.io · better-sqlite3 · SignalR · Python · pandas
