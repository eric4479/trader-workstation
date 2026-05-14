import sqlite3
import pandas as pd
import numpy as np
import os
from pathlib import Path
from datetime import datetime

# Configuration
DB_PATH = os.environ.get('TRADING_DB_PATH', str(Path(__file__).resolve().with_name('trading_data.db')))
MNQ_MULTIPLIER = 2.0  # $2 per point

def get_db_connection():
    return sqlite3.connect(DB_PATH)

def find_best_opportunities():
    """
    Analyzes historical data in the SQLite DB to find the best 
    mean-reverting or momentum opportunities.
    """
    print(f"[{datetime.now().strftime('%H:%M:%S')}] 🔍 Analyzing Market Opportunities...")
    
    conn = get_db_connection()
    
    # 1. Fetch the latest 100 bars for the primary symbol
    query = "SELECT * FROM candles WHERE timeframe = '1m' ORDER BY timestamp DESC LIMIT 200"
    df = pd.read_sql_query(query, conn)
    conn.close()
    
    if df.empty:
        print("❌ No data found in database. Run the Node.js engine first to collect data.")
        return

    # Process data
    df = df.sort_values('timestamp')
    df['close'] = df['close'].astype(float)
    
    # 2. Calculate Statistical Edge (Z-Score)
    # How far is price from its 50-period mean?
    df['ma50'] = df['close'].rolling(window=50).mean()
    df['std50'] = df['close'].rolling(window=50).std()
    df['z_score'] = (df['close'] - df['ma50']) / df['std50']
    
    # 3. Calculate Volatility (ATR-like)
    df['range'] = df['high'] - df['low']
    df['avg_range'] = df['range'].rolling(window=14).mean()
    
    latest = df.iloc[-1]
    z = latest['z_score']
    
    print("-" * 40)
    print(f"SYMBOL: MNQ (Database Sample)")
    print(f"Current Price: {latest['close']:.2f}")
    print(f"Z-Score: {z:.2f}")
    print(f"Volatility (14m): {latest['avg_range']:.2f} pts")
    
    # 4. Opportunity Scoring
    score = 0
    reason = "Neutral"
    
    if abs(z) > 2.0:
        score = abs(z) * 10
        reason = "Mean Reversion (Extreme Extension)"
    elif abs(z) < 0.5 and latest['avg_range'] > df['avg_range'].mean():
        score = 15
        reason = "Momentum Consolidation"
        
    print(f"SCORE: {score:.1f}")
    print(f"REASON: {reason}")
    print("-" * 40)

def calculate_kelly_sizing(win_rate, win_loss_ratio):
    """
    Standard Kelly Criterion: f* = (bp - q) / b
    b = odds (win/loss ratio)
    p = probability of win
    q = probability of loss
    """
    p = win_rate
    q = 1 - p
    b = win_loss_ratio
    
    if b == 0: return 0
    
    kelly = (b * p - q) / b
    return max(0, kelly)

if __name__ == "__main__":
    if not os.path.exists(DB_PATH):
        print(f"❌ Database not found at {DB_PATH}")
    else:
        find_best_opportunities()
        
        # Example Kelly Calculation (Mock stats)
        # In a real scenario, we would pull these from strategy_signals table
        print("\n📈 Kelly Sizing Example (Half-Kelly):")
        k = calculate_kelly_sizing(0.55, 1.5) # 55% win rate, 1.5 R/R
        print(f"Suggested Risk: {k * 0.5 * 100:.1f}% of equity")
