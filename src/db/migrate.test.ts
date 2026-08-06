import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databasePath, openDatabase } from './migrate.js';
import { Repo } from './repo.js';

describe('openDatabase', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nudge-migrate-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function columnsOf(path: string, table: string): string[] {
    const db = new Database(path, { readonly: true });
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    db.close();
    return rows.map((r) => r.name);
  }

  it('creates a database with every column', () => {
    const path = join(dir, 'fresh.db');
    openDatabase(path).close();

    expect(columnsOf(path, 'recipients')).toEqual(
      expect.arrayContaining(['email', 'teams_upn', 'slack_id', 'telegram_chat_id']),
    );
  });

  it('adds columns to a database created before they existed', () => {
    const path = join(dir, 'old.db');

    // A recipients table as it looked before Slack and Telegram were channels.
    // CREATE TABLE IF NOT EXISTS would leave this untouched, so without the
    // ALTER pass an existing deployment would break on the first read.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE recipients (
        gitlab_username TEXT PRIMARY KEY,
        email           TEXT,
        teams_upn       TEXT,
        channels        TEXT,
        snooze_until    TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO recipients (gitlab_username, email) VALUES ('alice', 'alice@example.com');
    `);
    old.close();

    const db = openDatabase(path);
    expect(columnsOf(path, 'recipients')).toEqual(
      expect.arrayContaining(['slack_id', 'telegram_chat_id']),
    );

    // The existing row survives, with the new addresses empty.
    const alice = new Repo(db).getRecipient('alice');
    expect(alice).toMatchObject({
      email: 'alice@example.com',
      slack_id: null,
      telegram_chat_id: null,
    });
    db.close();
  });

  it('is safe to open the same database repeatedly', () => {
    const path = join(dir, 'repeat.db');
    for (let i = 0; i < 3; i++) openDatabase(path).close();

    const columns = columnsOf(path, 'recipients');
    expect(columns.filter((c) => c === 'slack_id')).toHaveLength(1);
  });
});

describe('databasePath', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nudge-path-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the current name on a fresh install', () => {
    expect(databasePath({ NUDGE_DATA_DIR: dir })).toBe(join(dir, 'nudge.db'));
  });

  it('adopts the pre-rename file when it is the only one there', () => {
    // Otherwise the rename would present itself as a wiped database.
    openDatabase(join(dir, 'mra.db')).close();
    expect(databasePath({ NUDGE_DATA_DIR: dir })).toBe(join(dir, 'mra.db'));
  });

  it('prefers the current name once both exist', () => {
    openDatabase(join(dir, 'mra.db')).close();
    openDatabase(join(dir, 'nudge.db')).close();
    expect(databasePath({ NUDGE_DATA_DIR: dir })).toBe(join(dir, 'nudge.db'));
  });

  it('honours the pre-rename data directory variable', () => {
    expect(databasePath({ MRA_DATA_DIR: dir })).toBe(join(dir, 'nudge.db'));
  });
});
