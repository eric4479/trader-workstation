# PRD: Institutional MNQ Trading Workstation

**Project Goal:** Develop a high-fidelity, institutional-grade workstation for day trading MNQ (Micro Nasdaq-100) futures, focusing on volume-based edge and session dynamics.

## 1. Market Selection & Context
- **Instrument:** /MNQ (Micro Nasdaq-100).
- **Primary Data:** Real-time trade and quote stream via ProjectX.
- **Secondary Data:** Market Internals (VIX, SPY, QQQ, DXY) and High-Impact Economic Events.

## 2. Technical Analysis & Edge (The "Edge" Suite)
- **Volume Profile (VP):** Real-time calculation of Value Area High (VAH), Value Area Low (VAL), and Point of Control (POC).
- **Session Dynamics:**
    - **Asia Session:** High/Low capture (18:00 - 02:00 ET).
    - **Initial Balance (IB):** First hour high/low (09:30 - 10:30 ET).
    - **ORB:** 15-minute Opening Range Breakout (09:30 - 09:45 ET).
- **Order Flow:** Cumulative Volume Delta (CVD) to track aggressive buyer/seller exhaustion.

## 3. Strategies (MVP)
1. **The 80% Rule:** Market re-entering prior day Value Area and holding for 2 periods.
2. **Asia/IB Breakout:** Entering on a sustained break of Asia High/Low or IB High/Low confirmed by Delta.
3. **Mean Reversion:** VWAP deviation (>3 ATR) with reversal candlestick patterns.
4. **Volume Surge:** Breaking key levels (VAH/VAL/IB) with >150% average volume.

## 4. Risk Management (Institutional-Grade)
- **Circuit Breakers:** 3 consecutive losses or $1000 daily drawdown halt the system.
- **Dynamic Positioning:** Sizing based on ATR and Kelly Criterion (from historical algo performance).
- **Bracket Orders:** Mandatory Stop-Loss and Take-Profit on all entries.

## 5. Visualization (Elite Terminal)
- **Chart:** Candlestick with VWAP, EMA (9, 21, 50, 200), and Session Levels.
- **VP Overlay:** Visual representation of volume at price.
- **Confluence Score:** Real-time conviction gauge based on multiple algo alignments.
- **Algo Leaderboard:** Ranking strategies by Expected Value (EV) and Win Rate.

## 6. Implementation Workflow
1. **Foundation:** Fix core engine bugs and implement Volume Profile math.
2. **Intelligence:** Build session-based algos and confluence logic.
3. **Interface:** Upgrade the dashboard to a "Command Center" aesthetic.
4. **Validation:** Live paper trading to verify execution and signal accuracy.


## 7. Suggestions for Improvement
- **Fix "No data" error:** The terminal crashes when there is no data available.
- **Add more strategies:** Implement the strategies mentioned in the PRD.
- **Add more timeframes:** Implement the timeframes mentioned in the PRD.
- **Add more features:** Implement the features mentioned in the PRD.

## 8. What the user will get
    • A real-time trading terminal for futures markets.
    • A dashboard to visualize market data.
    • A suite of strategies to generate trading signals.
    • A risk management system to protect capital.
    • A way to backtest strategies on historical data. (ORB for MNQ, MGC, MES, YM)
    • A way to paper trade strategies to verify performance.
    • A way to optimize strategies based on historical data.



## 9. How to start
    1. Clone the repository.
    2. Install the dependencies.
    3. Run the terminal.

