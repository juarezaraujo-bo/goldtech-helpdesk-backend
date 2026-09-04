require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.resolve(__dirname, process.env.DB_PATH || 'helpdesk.sqlite');
const migrations = fs.readdirSync(path.join(__dirname, 'migrations'))
  .filter(file => /^\d+.*\.js$/.test(file)).sort()
  .map(file => require(path.join(__dirname, 'migrations', file)));
const db = new sqlite3.Database(dbPath);
const exec = sql => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve(this); }));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const close = () => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
async function migrate() {
  await exec('PRAGMA foreign_keys = ON;');
  await exec('BEGIN IMMEDIATE;');
  try {
    await exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);');
    const applied = new Set((await all('SELECT id FROM schema_migrations')).map(row => row.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) { console.log('Migration already applied: ' + migration.id); continue; }
      await exec(migration.up);
      await run('INSERT INTO schema_migrations (id) VALUES (?)', [migration.id]);
      console.log('Migration applied: ' + migration.id);
    }
    await exec('COMMIT;');
  } catch (error) {
    await exec('ROLLBACK;').catch(() => {});
    throw error;
  }
}
migrate().then(close).catch(async error => {
  console.error('Migration failed:', error.message);
  await close().catch(() => {});
  process.exitCode = 1;
});
