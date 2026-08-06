import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigProvider } from '../config/effective.js';
import { parseConfig } from '../config/load.js';
import { Audit } from '../db/audit.js';
import { openDatabase, type Db } from '../db/migrate.js';
import { Repo } from '../db/repo.js';
import { buildAdminServer } from './server.js';

const silent = pino({ level: 'silent' });
const PASSWORD = 'a-good-password';

const yaml = `
gitlab:
  url: https://gitlab.example.com
  token: t
  groups: [engineering]
admin:
  enabled: true
  password: ${PASSWORD}
schedule:
  cron: "0 9 * * 1-5"
  timezone: Europe/Zurich
exclude:
  projects: ["sandbox/**"]
notifications:
  channels: [email]
email:
  smtp: { host: smtp.example.com }
  from: nudge@example.com
recipients:
  - gitlab_username: alice
    email: alice@example.com
`;

describe('admin server', () => {
  let db: Db;
  let repo: Repo;
  let audit: Audit;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    repo = new Repo(db);
    audit = new Audit(db);
    const config = parseConfig(yaml, 'test.yaml', {});
    repo.seedRecipients(config.recipients);

    app = buildAdminServer(
      { provider: new ConfigProvider(config, repo), repo, audit, scheduler: null, logger: silent },
      {
        host: '127.0.0.1',
        port: 0,
        password: PASSWORD,
        sessionSecret: 'test-secret-for-signing-cookies',
        sessionTtlHours: 12,
      },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  /** Signs in and returns the session cookie header. */
  async function login(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(303);
    const cookie = res.cookies.find((c) => c.name === 'nudge_session');
    expect(cookie).toBeDefined();
    return `nudge_session=${cookie!.value}`;
  }

  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, cookie: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers: { cookie }, payload });

  describe('authentication', () => {
    it('refuses every page without a session', async () => {
      for (const url of ['/', '/pending', '/recipients', '/exclusions', '/silence', '/audit', '/settings']) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      }
    });

    it('refuses mutations without a session', async () => {
      const res = await app.inject({ method: 'POST', url: '/pause', payload: { enabled: 'true' } });
      expect(res.statusCode).toBe(401);
      expect(repo.getSetting('silence.enabled')).toBeUndefined();
    });

    it('serves health and the stylesheet unauthenticated', async () => {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/static/style.css' })).statusCode).toBe(200);
    });

    it('rejects a wrong password and records the attempt', async () => {
      const res = await app.inject({ method: 'POST', url: '/login', payload: { password: 'nope' } });
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('not right');

      const [entry] = audit.list({ action: 'auth.login' });
      expect(entry?.outcome).toBe('error');
    });

    it('rejects a forged session cookie', async () => {
      const res = await get('/', 'nudge_session=1786000000000');
      expect(res.statusCode).toBe(401);
    });

    it('lets a signed-in user through and logs out again', async () => {
      const cookie = await login();
      expect((await get('/', cookie)).statusCode).toBe(200);

      const out = await post('/logout', cookie, {});
      expect(out.statusCode).toBe(303);
      expect(audit.list({ action: 'auth.logout' })).toHaveLength(1);
    });
  });

  describe('page rendering', () => {
    it('renders real content inside <main> on every page', async () => {
      const cookie = await login();

      for (const url of ['/', '/pending', '/recipients', '/exclusions', '/silence', '/audit', '/settings']) {
        const res = await get(url, cookie);
        expect(res.statusCode, url).toBe(200);

        const main = /<main>([\s\S]*)<\/main>/.exec(res.body)?.[1] ?? '';
        // Guards against template values that stringify to "[object Object]".
        expect(main, url).not.toContain('[object Object]');
        expect(main.trim().length, url).toBeGreaterThan(50);
        expect(main, url).toContain('<div class="card">');
      }
    });

    it('escapes hostile content rather than rendering it', async () => {
      repo.upsertRecipient({
        gitlab_username: '<script>alert(1)</script>',
        email: 'x@example.com',
        teams_upn: null,
        channels: null,
        snooze_until: null,
      });

      const res = await get('/recipients', await login());
      expect(res.body).not.toContain('<script>alert(1)</script>');
      expect(res.body).toContain('&lt;script&gt;');
    });

    it('shows the paused banner only while paused', async () => {
      const cookie = await login();
      expect((await get('/', cookie)).body).not.toContain('Notifications are paused');

      repo.setSetting('silence.enabled', true);
      expect((await get('/', cookie)).body).toContain('Notifications are paused');
    });

    it('carries a flash message through the redirect', async () => {
      const cookie = await login();
      const res = await get('/exclusions?ok=Added%20something', cookie);
      expect(res.body).toContain('Added something');
    });
  });

  describe('exclusions', () => {
    it('adds one and writes an audit row', async () => {
      const cookie = await login();
      const res = await post('/exclusions/add', cookie, {
        kind: 'project',
        pattern: 'playground/**',
        note: 'noisy',
      });

      expect(res.statusCode).toBe(303);
      expect(repo.listExclusions('project').map((e) => e.pattern)).toEqual(['playground/**']);

      const [entry] = audit.list({ action: 'exclusion.add' });
      expect(entry?.target).toBe('project:playground/**');
      expect(entry?.after).toMatchObject({ pattern: 'playground/**', note: 'noisy' });
    });

    it('normalises a merge request URL pasted with a sub-page', async () => {
      const cookie = await login();
      await post('/exclusions/add', cookie, {
        kind: 'muted_mr',
        pattern: 'https://gitlab.example.com/a/b/-/merge_requests/42/diffs?x=1',
      });

      expect(repo.listExclusions('muted_mr')[0]?.pattern).toBe(
        'https://gitlab.example.com/a/b/-/merge_requests/42',
      );
    });

    it('reports a duplicate instead of adding it twice', async () => {
      const cookie = await login();
      await post('/exclusions/add', cookie, { kind: 'project', pattern: 'dup/**' });
      const res = await post('/exclusions/add', cookie, { kind: 'project', pattern: 'dup/**' });

      expect(res.headers.location).toContain('err=');
      expect(repo.listExclusions('project')).toHaveLength(1);
    });

    it('rejects an unknown kind', async () => {
      const res = await post('/exclusions/add', await login(), { kind: 'nonsense', pattern: 'x' });
      expect(res.headers.location).toContain('err=');
      expect(repo.listExclusions()).toHaveLength(0);
    });

    it('removes one and records what was removed', async () => {
      const cookie = await login();
      const added = repo.addExclusion('user', 'dependabot', null, 'admin')!;

      const res = await post('/exclusions/remove', cookie, { id: String(added.id) });
      expect(res.statusCode).toBe(303);
      expect(repo.listExclusions('user')).toHaveLength(0);

      const [entry] = audit.list({ action: 'exclusion.remove' });
      expect(entry?.before).toMatchObject({ pattern: 'dependabot' });
    });

    it('cannot delete an entry that came from config.yaml', async () => {
      const res = await get('/exclusions', await login());
      // The file entry is shown but offers no remove button.
      expect(res.body).toContain('sandbox/**');
      expect(res.body).toContain('edit config.yaml to remove');
    });
  });

  describe('recipients', () => {
    it('adds a recipient', async () => {
      const cookie = await login();
      const res = await post('/recipients/save', cookie, {
        gitlab_username: 'bob',
        email: 'bob@example.com',
      });

      expect(res.statusCode).toBe(303);
      expect(repo.getRecipient('bob')?.email).toBe('bob@example.com');
      expect(audit.list({ action: 'recipient.add' })).toHaveLength(1);
    });

    it('rejects a malformed email and changes nothing', async () => {
      const res = await post('/recipients/save', await login(), {
        gitlab_username: 'bob',
        email: 'not-an-email',
      });

      expect(res.headers.location).toContain('err=');
      expect(repo.getRecipient('bob')).toBeNull();
    });

    it('rejects a malformed snooze date', async () => {
      const res = await post('/recipients/save', await login(), {
        gitlab_username: 'alice',
        email: 'alice@example.com',
        snooze_until: 'next tuesday',
      });

      expect(res.headers.location).toContain('err=');
      expect(repo.getRecipient('alice')?.snooze_until).toBeNull();
    });

    it('snoozes someone and records the before value', async () => {
      const cookie = await login();
      await post('/recipients/save', cookie, {
        gitlab_username: 'alice',
        email: 'alice@example.com',
        snooze_until: '2027-01-01',
      });

      expect(repo.getRecipient('alice')?.snooze_until).toBe('2027-01-01');
      const [entry] = audit.list({ action: 'recipient.update' });
      expect(entry?.before).toMatchObject({ snooze_until: null });
      expect(entry?.after).toMatchObject({ snooze_until: '2027-01-01' });
    });

    it('toggles enabled without losing the other fields', async () => {
      const cookie = await login();
      await post('/recipients/toggle', cookie, { gitlab_username: 'alice', enabled: 'false' });

      const alice = repo.getRecipient('alice')!;
      expect(alice.enabled).toBe(false);
      expect(alice.email).toBe('alice@example.com');
    });

    it('deletes a recipient', async () => {
      const cookie = await login();
      await post('/recipients/delete', cookie, { gitlab_username: 'alice' });
      expect(repo.getRecipient('alice')).toBeNull();
      expect(audit.list({ action: 'recipient.delete' })).toHaveLength(1);
    });
  });

  describe('silence', () => {
    it('pauses and resumes, recording both transitions', async () => {
      const cookie = await login();

      await post('/pause', cookie, { enabled: 'true' });
      expect(repo.getSetting('silence.enabled')).toBe(true);

      await post('/pause', cookie, { enabled: 'false' });
      expect(repo.getSetting('silence.enabled')).toBe(false);

      const entries = audit.list({ action: 'silence.pause' });
      expect(entries.map((e) => e.after)).toEqual([false, true]);
    });

    it('saves quiet hours and clears them when both fields are empty', async () => {
      const cookie = await login();

      await post('/silence/quiet-hours', cookie, { start: '18:00', end: '08:00' });
      expect(repo.getSetting('silence.quiet_hours')).toEqual({ start: '18:00', end: '08:00' });

      await post('/silence/quiet-hours', cookie, { start: '', end: '' });
      expect(repo.getSetting('silence.quiet_hours')).toBeNull();
    });

    it('rejects a malformed quiet-hours time', async () => {
      const res = await post('/silence/quiet-hours', await login(), { start: '6pm', end: '08:00' });
      expect(res.headers.location).toContain('err=');
      expect(repo.getSetting('silence.quiet_hours')).toBeUndefined();
    });

    it('saves working days from checkboxes', async () => {
      const cookie = await login();
      await post('/silence/working-days', cookie, { days: ['mon', 'wed'] });
      expect(repo.getSetting('silence.working_days')).toEqual(['mon', 'wed']);
    });

    it('adds and removes a holiday, keeping the list sorted', async () => {
      const cookie = await login();
      await post('/silence/holiday/add', cookie, { date: '2026-12-26' });
      await post('/silence/holiday/add', cookie, { date: '2026-12-25' });
      expect(repo.getSetting('silence.holidays')).toEqual(['2026-12-25', '2026-12-26']);

      await post('/silence/holiday/remove', cookie, { date: '2026-12-25' });
      expect(repo.getSetting('silence.holidays')).toEqual(['2026-12-26']);
    });

    it('rejects a malformed holiday date', async () => {
      const res = await post('/silence/holiday/add', await login(), { date: '25 December' });
      expect(res.headers.location).toContain('err=');
      expect(repo.getSetting('silence.holidays')).toBeUndefined();
    });
  });

  describe('settings', () => {
    it('saves a valid schedule', async () => {
      const cookie = await login();
      const res = await post('/settings/schedule', cookie, {
        cron: '*/30 * * * *',
        timezone: 'UTC',
      });

      expect(res.headers.location).toContain('ok=');
      expect(repo.getSetting('schedule.cron')).toBe('*/30 * * * *');
      expect(repo.getSetting('schedule.timezone')).toBe('UTC');
    });

    it('rejects an invalid cron expression', async () => {
      const res = await post('/settings/schedule', await login(), {
        cron: 'every other tuesday',
        timezone: 'UTC',
      });

      expect(res.headers.location).toContain('err=');
      expect(repo.getSetting('schedule.cron')).toBeUndefined();
    });

    it('rejects an unknown timezone', async () => {
      const res = await post('/settings/schedule', await login(), {
        cron: '0 9 * * *',
        timezone: 'Mars/Olympus',
      });

      expect(res.headers.location).toContain('err=');
      expect(repo.getSetting('schedule.timezone')).toBeUndefined();
    });

    it('writes every rule toggle explicitly, including the unchecked ones', async () => {
      const cookie = await login();
      // Only one box ticked; the rest must be stored as false, not left untouched.
      await post('/settings/rules', cookie, {
        'rules.reviewer_not_approved': 'on',
        'rules.min_age_hours': '24',
        'notifications.max_items_per_digest': '10',
      });

      expect(repo.getSetting('rules.reviewer_not_approved')).toBe(true);
      expect(repo.getSetting('rules.assignee_action_pending')).toBe(false);
      expect(repo.getSetting('rules.unresolved_threads')).toBe(false);
      expect(repo.getSetting('rules.min_age_hours')).toBe(24);
      expect(repo.getSetting('notifications.max_items_per_digest')).toBe(10);
    });

    it('rejects a negative age threshold', async () => {
      const res = await post('/settings/rules', await login(), {
        'rules.min_age_hours': '-5',
        'notifications.max_items_per_digest': '10',
      });
      expect(res.headers.location).toContain('err=');
    });

    it('clears every override on reset', async () => {
      const cookie = await login();
      repo.setSetting('rules.min_age_hours', 48);
      repo.setSetting('schedule.cron', '*/5 * * * *');

      await post('/settings/reset', cookie, {});
      expect(repo.allSettings()).toEqual({});
      expect(audit.list({ action: 'setting.reset' })).toHaveLength(1);
    });

    it('never exposes the token or SMTP password', async () => {
      const res = await get('/settings', await login());
      expect(res.body).toContain('gitlab.example.com');
      expect(res.body).not.toContain('>t<');
      expect(res.body).toContain('••••••••');
    });
  });

  describe('pending', () => {
    it('lists the last completed run and offers a mute button', async () => {
      const cookie = await login();
      const runId = repo.startRun('cli', false);
      repo.finishRun(runId, { status: 'ok' });
      repo.replaceSnapshot(runId, [
        {
          gitlab_username: 'alice',
          mr_url: 'https://gitlab.example.com/a/b/-/merge_requests/7',
          mr_title: 'Something to review',
          project_path: 'a/b',
          author: 'bob',
          reasons: ['REVIEW_REQUESTED'],
          waiting_since: '2026-08-01T00:00:00Z',
          deliverable: true,
          skip_reason: null,
        },
      ]);

      const res = await get('/pending', cookie);
      expect(res.body).toContain('Something to review');
      expect(res.body).toContain('Review');
      expect(res.body).toContain('/pending/mute');
    });

    it('flags an undeliverable person in the list', async () => {
      const cookie = await login();
      const runId = repo.startRun('cli', false);
      repo.finishRun(runId, { status: 'ok' });
      repo.replaceSnapshot(runId, [
        {
          gitlab_username: 'carol',
          mr_url: 'https://gitlab.example.com/a/b/-/merge_requests/8',
          mr_title: 'Blocked on carol',
          project_path: 'a/b',
          author: 'bob',
          reasons: ['ASSIGNEE_ACTION'],
          waiting_since: '2026-08-01T00:00:00Z',
          deliverable: false,
          skip_reason: 'no recipient mapping',
        },
      ]);

      const res = await get('/pending', cookie);
      expect(res.body).toContain('no recipient mapping');
    });

    it('mutes a merge request straight from the list', async () => {
      const cookie = await login();
      const res = await post('/pending/mute', cookie, {
        url: 'https://gitlab.example.com/a/b/-/merge_requests/7/diffs',
      });

      expect(res.statusCode).toBe(303);
      expect(repo.listExclusions('muted_mr')[0]?.pattern).toBe(
        'https://gitlab.example.com/a/b/-/merge_requests/7',
      );
    });
  });

  describe('audit page', () => {
    it('filters by action prefix', async () => {
      const cookie = await login();
      audit.record({ actor: 'admin', action: 'exclusion.add', target: 'project:x' });
      audit.record({ actor: 'scheduler', action: 'notification.send', target: 'alice/email' });

      const filtered = await get('/audit?action=exclusion', cookie);
      expect(filtered.body).toContain('project:x');
      expect(filtered.body).not.toContain('alice/email');
    });

    it('marks a failed delivery', async () => {
      const cookie = await login();
      audit.record({
        actor: 'scheduler',
        action: 'notification.send',
        target: 'alice/email',
        outcome: 'error',
        detail: 'SMTP 550',
      });

      const res = await get('/audit', cookie);
      expect(res.body).toContain('SMTP 550');
      expect(res.body).toContain('chip error');
    });
  });
});
