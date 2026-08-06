import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.MRA_DATA_DIR ?? 'data');
}

export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(dataDir(env), 'mra.db');
}

/**
 * Opens the database and applies the schema. The schema is written with
 * IF NOT EXISTS throughout, so this is safe to run on every startup; future
 * schema changes append additively rather than rewriting existing tables.
 */
export function openDatabase(path?: string, env: NodeJS.ProcessEnv = process.env): Db {
  const file = path ?? databasePath(env);
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('busy_timeout = 5000');

  const schema = readFileSync(resolve(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  addMissingColumns(db);
  return db;
}

/**
 * Columns added to existing tables after the first release.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched, so a database
 * created before a column existed would never gain it. Each entry is applied only
 * when absent, which keeps startup idempotent and upgrades in place.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'recipients', column: 'slack_id', definition: 'TEXT' },
  { table: 'recipients', column: 'telegram_chat_id', definition: 'TEXT' },
];

function addMissingColumns(db: Db): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
