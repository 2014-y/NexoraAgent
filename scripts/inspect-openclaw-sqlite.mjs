import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';

const databasePath = path.resolve(process.argv[2] || '');
if (!databasePath) throw new Error('database path is required');

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const findIndex = process.argv.indexOf('--find');
  if (findIndex >= 0) {
    const needle = process.argv[findIndex + 1];
    if (!needle) throw new Error('--find requires a search string');
    for (const table of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
      const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table.name)})`).all();
      for (const column of columns.filter((entry) => /TEXT/i.test(String(entry.type || '')))) {
        const query = `SELECT rowid AS row_id, * FROM ${JSON.stringify(table.name)} WHERE instr(CAST(${JSON.stringify(column.name)} AS TEXT), ?) > 0 LIMIT 20`;
        for (const row of db.prepare(query).all(needle)) {
          const value = String(row[column.name] || '');
          const safeValue = value.replace(/sk-[A-Za-z0-9_-]{12,}/g, '***');
          const offset = Math.max(0, safeValue.indexOf(needle) - 120);
          console.log(JSON.stringify({
            table: table.name,
            column: column.name,
            rowId: row.row_id,
            ...(typeof row.state_key === 'string' ? { stateKey: row.state_key } : {}),
            preview: safeValue.slice(offset, offset + 500)
          }));
        }
      }
    }
    process.exit(0);
  }
  for (const row of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
    const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(row.name)})`).all().map((column) => column.name);
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${JSON.stringify(row.name)}`).get().count;
    console.log(JSON.stringify({ table: row.name, count, columns, sql: row.sql }));
  }
  if (process.argv.includes('--auth') && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_profile_store'").get()) {
    const sanitize = (value, key = '') => {
      if (Array.isArray(value)) return value.map((item) => sanitize(item));
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
      }
      if (typeof value === 'string' && /key|token|secret|credential|password/i.test(key)) {
        return { length: value.length, sha256: crypto.createHash('sha256').update(value).digest('hex').slice(0, 12) };
      }
      return value;
    };
    for (const row of db.prepare('SELECT store_key, store_json, updated_at FROM auth_profile_store').all()) {
      console.log(JSON.stringify({ authStore: row.store_key, value: sanitize(JSON.parse(row.store_json)), updatedAt: row.updated_at }));
    }
    for (const row of db.prepare('SELECT state_key, state_json, updated_at FROM auth_profile_state').all()) {
      console.log(JSON.stringify({ authState: row.state_key, value: sanitize(JSON.parse(row.state_json)), updatedAt: row.updated_at }));
    }
  }
} finally {
  db.close();
}
