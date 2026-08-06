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
  return db;
}
