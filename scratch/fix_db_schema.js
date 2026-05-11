const Database = require('better-sqlite3');
const db = new Database('trading_data.db');

console.log("Checking strategy_signals table schema...");

try {
  const info = db.pragma('table_info(strategy_signals)');
  const columns = info.map(c => c.name);
  
  console.log("Current columns:", columns.join(', '));

  if (!columns.includes('target1')) {
    console.log("Adding target1 column...");
    db.prepare('ALTER TABLE strategy_signals ADD COLUMN target1 REAL').run();
  }

  if (!columns.includes('target2')) {
    console.log("Adding target2 column...");
    db.prepare('ALTER TABLE strategy_signals ADD COLUMN target2 REAL').run();
  }

  console.log("✅ Database migration complete.");
} catch (err) {
  console.error("❌ Migration failed:", err.message);
} finally {
  db.close();
}
