#!/bin/bash
# ============================================================
#  🚀 Trader Workstation — Easy Start Script
# ============================================================

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║   🖥  Elite MNQ Trader Workstation        ║${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── 1. Check Node.js ────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Install from: https://nodejs.org${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# ── 2. Check Python ─────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo -e "${YELLOW}⚠ Python3 not found — Python scanner will be unavailable.${NC}"
else
  echo -e "${GREEN}✓ Python3 $(python3 --version 2>&1 | awk '{print $2}')${NC}"
fi

# ── 3. Install Node dependencies if needed ──────────────────
if [ ! -d "node_modules" ]; then
  echo -e "${YELLOW}📦 Installing Node.js dependencies…${NC}"
  npm install
  echo -e "${GREEN}✓ Node modules installed${NC}"
fi

# ── 4. Setup Python venv if not already done ────────────────
if [ ! -d "venv" ] || [ ! -f "venv/bin/python3" ]; then
  echo -e "${YELLOW}🐍 Setting up Python virtual environment…${NC}"
  bash setup_venv.sh
fi

# ── 5. Check .env exists ────────────────────────────────────
if [ ! -f ".env" ]; then
  echo -e "${RED}✗ .env file missing! Copy .env.example to .env and fill in your API keys.${NC}"
  exit 1
fi
echo -e "${GREEN}✓ .env config found${NC}"

echo ""
echo -e "${BOLD}Choose a startup mode:${NC}"
echo ""
echo -e "  ${CYAN}[1]${NC} 🚀 Full Engine   — Live stream + Dashboard + Signals"
echo -e "  ${CYAN}[2]${NC} 📊 Dashboard Only — Serve the UI on cached data (no stream)"
echo -e "  ${CYAN}[3]${NC} 📥 Download History — Backfill OHLCV bars from TopstepX"
echo -e "  ${CYAN}[4]${NC} 🔍 Python Scanner  — Run Z-score / Kelly opportunity scan"
echo -e "  ${CYAN}[5]${NC} 🗄  Check Database  — Print DB candle counts & latest bars"
echo -e "  ${CYAN}[6]${NC} ❌ Exit"
echo ""
read -rp "Enter choice [1-6]: " CHOICE

case "$CHOICE" in
  1)
    echo ""
    echo -e "${GREEN}🚀 Starting Full Engine (stream + dashboard)…${NC}"
    echo -e "${YELLOW}   Dashboard → http://localhost:3000${NC}"
    echo ""
    node index.js
    ;;
  2)
    echo ""
    echo -e "${GREEN}📊 Starting Dashboard only…${NC}"
    echo -e "${YELLOW}   Dashboard → http://localhost:3000${NC}"
    echo ""
    node -e "require('./dashboard').startDashboard()"
    ;;
  3)
    echo ""
    read -rp "How many days of history to download? [default: 30]: " DAYS
    DAYS=${DAYS:-30}
    echo -e "${GREEN}📥 Downloading ${DAYS} days of OHLCV history…${NC}"
    echo ""
    node downloadHistory.js "$DAYS"
    ;;
  4)
    echo ""
    echo -e "${GREEN}🔍 Running Python market scanner…${NC}"
    echo ""
    ./venv/bin/python3 scanner.py
    ;;
  5)
    echo ""
    echo -e "${GREEN}🗄  Checking database…${NC}"
    echo ""
    node check_db.js
    ;;
  6)
    echo -e "${YELLOW}Goodbye.${NC}"
    exit 0
    ;;
  *)
    echo -e "${RED}Invalid choice. Run ./start.sh again.${NC}"
    exit 1
    ;;
esac
