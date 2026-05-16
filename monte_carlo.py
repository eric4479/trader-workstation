import sqlite3
import pandas as pd
import numpy as np
import random
import os
from pathlib import Path

DB_PATH = os.environ.get('TRADING_DB_PATH', str(Path(__file__).resolve().with_name('trading_data.db')))

def run_simulation(iterations=10000, account_size=50000, risk_per_trade=0.01):
    """
    Runs a Monte Carlo simulation based on historical signal data.
    """
    if not os.path.exists(DB_PATH):
        print("❌ Database not found.")
        return

    conn = sqlite3.connect(DB_PATH)
    # Pull realized P&L from strategy_signals
    # We calculate P&L in points
    query = """
    SELECT 
        algo_name,
        status,
        ABS(target - entry_price) as win_pts,
        ABS(stop - entry_price) as loss_pts
    FROM strategy_signals 
    WHERE status IN ('WIN', 'LOSS')
    """
    df = pd.read_sql_query(query, conn)
    conn.close()

    if len(df) < 5:
        print("⚠️ Insufficient data for simulation. Need at least 5 completed trades.")
        return

    # Convert to a list of outcomes (P&L in multipliers of risk)
    # E.g., if a win was 20 pts and loss was 10 pts, outcome is +2.0
    outcomes = []
    for _, row in df.iterrows():
        if row['status'] == 'WIN':
            outcomes.append(row['win_pts'] / row['loss_pts'] if row['loss_pts'] > 0 else 1.0)
        else:
            outcomes.append(-1.0)

    print(f"📊 Analyzing {len(outcomes)} trades across {iterations} simulations...")

    all_end_balances = []
    max_drawdowns = []
    ruin_count = 0
    ruin_threshold = account_size * 0.8 # 20% drawdown = ruin for some prop firms

    for _ in range(iterations):
        balance = account_size
        peak = account_size
        current_drawdown = 0
        max_dd = 0
        
        # Simulate a sequence of 50 trades
        for _ in range(50):
            outcome = random.choice(outcomes)
            risk_amount = balance * risk_per_trade
            balance += (risk_amount * outcome)
            
            if balance > peak:
                peak = balance
            
            dd = (peak - balance) / peak
            if dd > max_dd:
                max_dd = dd
            
            if balance < ruin_threshold:
                ruin_count += 1
                break
        
        all_end_balances.append(balance)
        max_drawdowns.append(max_dd)

    # Statistics
    avg_end = np.mean(all_end_balances)
    prob_profit = len([b for b in all_end_balances if b > account_size]) / iterations
    avg_max_dd = np.mean(max_drawdowns)
    prob_ruin = ruin_count / iterations

    print("-" * 40)
    print(f"MONTE CARLO RESULTS (50 Trade Horizon)")
    print(f"Initial Capital: ${account_size:,.2f}")
    print(f"Avg End Balance: ${avg_end:,.2f}")
    print(f"Probability of Profit: {prob_profit*100:.1f}%")
    print(f"Avg Max Drawdown: {avg_max_dd*100:.1f}%")
    print(f"Probability of 20% Drawdown: {prob_ruin*100:.1f}%")
    print("-" * 40)

if __name__ == "__main__":
    run_simulation()
