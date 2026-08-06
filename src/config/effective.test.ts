import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/migrate.js';
import { Repo } from '../db/repo.js';
import { parseConfig } from './load.js';
import { ConfigProvider } from './effective.js';

const yaml = `
gitlab:
  url: https://gitlab.example.com
  token: t
  groups: [engineering]
admin:
  enabled: false
schedule:
  cron: "0 9 * * 1-5"
  timezone: Europe/Zurich
rules:
  min_age_hours: 12
exclude:
  projects: ["sandbox/**"]
  users: [renovate-bot]
  mr_labels: [wip]
  bots: true
silence:
  enabled: false
  muted_merge_requests: ["https://gitlab.example.com/a/b/-/merge_requests/1"]
notifications:
  channels: [email]
email:
  smtp: { host: smtp.example.com }
  from: mra@example.com
recipients:
  - gitlab_username: alice
    email: alice@example.com
`;

function provider(db: Db, env: NodeJS.ProcessEnv = {}) {
  const cfg = parseConfig(yaml, 'test.yaml', {});
  return new ConfigProvider(cfg, new Repo(db), env);
}

describe('ConfigProvider', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('falls back to file values when nothing is overridden', () => {
    const eff = provider(db).resolve();
    expect(eff.schedule.cron).toBe('0 9 * * 1-5');
    expect(eff.rules.min_age_hours).toBe(12);
    expect(eff.exclude.projects).toEqual(['sandbox/**']);
    expect(eff.silence.enabled).toBe(false);
  });

  it('prefers a database override over the file default', () => {
    new Repo(db).setSetting('rules.min_age_hours', 48);
    expect(provider(db).resolve().rules.min_age_hours).toBe(48);
  });

  it('ignores a stored override that no longer validates', () => {
    new Repo(db).setSetting('rules.min_age_hours', 'not-a-number');
    expect(provider(db).resolve().rules.min_age_hours).toBe(12);
  });

  it('merges file and panel exclusions without duplicating', () => {
    const repo = new Repo(db);
    repo.addExclusion('project', 'playground/**', 'noisy', 'admin');
    repo.addExclusion('project', 'sandbox/**', 'already in the file', 'admin');

    const eff = provider(db).resolve();
    expect(eff.exclude.projects).toEqual(['sandbox/**', 'playground/**']);
  });

  it('tags each exclusion with its origin', () => {
    new Repo(db).addExclusion('user', 'dependabot', null, 'admin');
    const entries = provider(db).exclusionEntries('user');
    expect(entries).toEqual([
      expect.objectContaining({ pattern: 'renovate-bot', origin: 'file', id: null }),
      expect.objectContaining({ pattern: 'dependabot', origin: 'panel' }),
    ]);
  });

  it('treats muted merge requests as an exclusion kind', () => {
    new Repo(db).addExclusion('muted_mr', 'https://gitlab.example.com/a/b/-/merge_requests/9', null, 'admin');
    const eff = provider(db).resolve();
    expect(eff.silence.muted_merge_requests).toEqual([
      'https://gitlab.example.com/a/b/-/merge_requests/1',
      'https://gitlab.example.com/a/b/-/merge_requests/9',
    ]);
  });

  it('lets MRA_SILENCE force silence on but never off', () => {
    expect(provider(db, { MRA_SILENCE: '1' }).resolve().silence.enabled).toBe(true);

    new Repo(db).setSetting('silence.enabled', true);
    expect(provider(db, { MRA_SILENCE: '0' }).resolve().silence.enabled).toBe(true);
  });

  it('uses file recipients until the database is seeded, then the database', () => {
    const p = provider(db);
    expect(p.recipients().map((r) => r.gitlab_username)).toEqual(['alice']);

    const repo = new Repo(db);
    repo.seedRecipients(p.fileConfig.recipients);
    repo.upsertRecipient({
      gitlab_username: 'bob',
      email: 'bob@example.com',
      teams_upn: null,
      channels: null,
      snooze_until: null,
    });

    expect(provider(db).recipients().map((r) => r.gitlab_username)).toEqual(['alice', 'bob']);
  });

  it('reports whether a key is currently overridden', () => {
    const p = provider(db);
    expect(p.hasOverride('schedule.cron')).toBe(false);
    new Repo(db).setSetting('schedule.cron', '*/30 * * * *');
    expect(p.hasOverride('schedule.cron')).toBe(true);
  });
});
