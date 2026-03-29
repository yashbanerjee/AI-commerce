import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function main(): Promise<void> {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    throw new Error('No migrations found in migrations/');
  }
  const pool = getPool();
  await pool.query(LEDGER_SQL);

  for (const file of files) {
    const already = await pool.query('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [file]);
    if (already.rows.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`Skipping ${file} (already applied).`);
      continue;
    }
    const sqlPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(sqlPath, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`Applying ${file}...`);
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
  }
  // eslint-disable-next-line no-console
  console.log(`Migrations up to date (${files.length} file(s) in tree).`);
  await pool.end();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
