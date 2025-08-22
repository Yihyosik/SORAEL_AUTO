// Soraiel Migration Script (v1.1.1)
const fs = require('fs');
const path = require('path');

function ensureDirs() {
  ['data', 'logs', 'runs', 'metrics', 'backups'].forEach(d => {
    const p = path.join(__dirname, '..', d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  });
}

function nodeVersionCheck() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) throw new Error(`Node.js 20+ required (current: ${process.version})`);
}

function backupData() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, '..', 'backups', ts);
  fs.mkdirSync(dir, { recursive: true });
  ['data/soraiel.db', '.env'].forEach(f => {
    const p = path.join(__dirname, '..', f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dir, path.basename(f)));
  });
  console.log(`  Backup -> backups/${ts}/`);
}

// SQLite: ALTER TABLE ... IF NOT EXISTS 미지원 → 스키마 검사/중복 에러 무시 전략
function migrateDatabaseIfAvailable() {
  let Database;
  try { Database = require('better-sqlite3'); } catch { console.log('  (skip) better-sqlite3 not installed'); return; }
  const dbPath = path.join(__dirname, '..', 'data', 'soraiel.db');
  const db = new Database(dbPath);

  const hasColumn = (table, col) => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => r.name === col);
  };

  db.exec(`CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, instruction TEXT NOT NULL,
    context TEXT, enabled INTEGER DEFAULT 1, created_at TEXT NOT NULL
  )`);

  if (!hasColumn('rules', 'last_run')) db.exec(`ALTER TABLE rules ADD COLUMN last_run TEXT`);
  if (!hasColumn('rules', 'run_count')) db.exec(`ALTER TABLE rules ADD COLUMN run_count INTEGER DEFAULT 0`);

  db.exec(`CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, params TEXT, success INTEGER, timestamp TEXT NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, value REAL, tags TEXT, timestamp INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp)`);

  db.close();
}

function updateConfiguration() {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const old = pkg.version;
  pkg.version = '1.1.1';
  pkg.scripts = { ...pkg.scripts, 'test:smoke': 'node scripts/smoke-test.js', migrate: 'node scripts/migrate.js' };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log(`  package.json: ${old} → ${pkg.version}`);
}

async function migrate() {
  console.log('🔄 Starting Soraiel Migration v1.0 → v1.1.1\n');
  nodeVersionCheck();
  ensureDirs();
  backupData();
  migrateDatabaseIfAvailable();
  updateConfiguration();
  console.log('🎉 Migration completed successfully!');
}

if (require.main === module) migrate().catch(e => { console.error('Migration failed:', e); process.exit(1); });
module.exports = { migrate };