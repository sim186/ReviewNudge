import { ConfigProvider } from './config/effective.js';
import { loadConfig } from './config/load.js';
import type { Config } from './config/schema.js';
import { Audit } from './db/audit.js';
import { openDatabase, type Db } from './db/migrate.js';
import { Repo } from './db/repo.js';
import { logger } from './logger.js';

export interface App {
  config: Config;
  provider: ConfigProvider;
  repo: Repo;
  audit: Audit;
  db: Db;
  close(): void;
}

/**
 * Loads configuration, opens the database, and seeds recipients on first start.
 *
 * Seeding is insert-if-absent, so config.yaml populates an empty deployment but never
 * overwrites what an operator has since changed in the panel.
 */
export function createApp(configPath?: string): App {
  const config = loadConfig(configPath);
  const db = openDatabase();
  const repo = new Repo(db);
  const audit = new Audit(db);

  const seeded = repo.seedRecipients(config.recipients);
  if (seeded > 0) {
    logger.info({ seeded }, 'seeded recipients from config.yaml');
    audit.record({
      actor: 'system',
      action: 'recipient.seed',
      after: { count: seeded },
      detail: 'initial import from config.yaml',
    });
  }

  return {
    config,
    provider: new ConfigProvider(config, repo),
    repo,
    audit,
    db,
    close: () => db.close(),
  };
}
