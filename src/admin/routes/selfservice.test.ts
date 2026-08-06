import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigProvider } from '../../config/effective.js';
import { parseConfig } from '../../config/load.js';
import { Audit } from '../../db/audit.js';
import { openDatabase, type Db } from '../../db/migrate.js';
import { Repo } from '../../db/repo.js';
import { mintRecipientToken } from '../../notify/tokens.js';
import { buildAdminServer } from '../server.js';

const silent = pino({ level: 'silent' });
const SECRET = 'a-stable-secret-for-signing';
const MR = 'https://gitlab.example.com/a/b/-/merge_requests/7';

const yaml = `
gitlab:
  url: https://gitlab.example.com
  token: t
  groups: [engineering]
admin:
  enabled: true
  password: a-good-password
  host: mra.example.com
schedule:
  timezone: Europe/Zurich
notifications:
  channels: [email]
email:
  smtp: { host: smtp.example.com }
  from: mra@example.com
recipients:
  - gitlab_username: alice
    email: alice@example.com
`;

describe('recipient self-service', () => {
  let db: Db;
  let repo: Repo;
  let audit: Audit;
  let app: FastifyInstance;
  let token: string;

  function buildApp(secret = SECRET): FastifyInstance {
    const config = parseConfig(yaml, 'test.yaml', {});
    return buildAdminServer(
      { provider: new ConfigProvider(config, repo), repo, audit, scheduler: null, logger: silent },
      {
        host: '127.0.0.1',
        port: 0,
        password: 'a-good-password',
        sessionSecret: secret,
        sessionTtlHours: 12,
      },
    );
  }

  /** A completed run whose snapshot has one item waiting on alice. */
  function seedSnapshot(): void {
    const runId = repo.startRun('cli', false);
    repo.finishRun(runId, { status: 'ok' });
    repo.replaceSnapshot(runId, [
      {
        gitlab_username: 'alice',
        mr_url: MR,
        mr_title: 'Rework the config loader',
        project_path: 'a/b',
        author: 'dave',
        reasons: ['REVIEW_REQUESTED'],
        waiting_since: '2026-08-01T00:00:00Z',
        deliverable: true,
        skip_reason: null,
      },
    ]);
  }

  beforeEach(async () => {
    db = openDatabase(':memory:');
    repo = new Repo(db);
    audit = new Audit(db);
    repo.seedRecipients(parseConfig(yaml, 'test.yaml', {}).recipients);
    seedSnapshot();

    token = mintRecipientToken('alice', SECRET);
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url, payload });

  describe('access', () => {
    it('needs no admin session', async () => {
      const res = await get(`/me/${token}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Hello alice');
    });

    it('rejects a token signed with another secret', async () => {
      const forged = mintRecipientToken('alice', 'a-different-secret');
      const res = await get(`/me/${forged}`);
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('no longer works');
    });

    it('rejects a tampered token', async () => {
      const res = await get(`/me/${token.slice(0, -3)}xyz`);
      expect(res.statusCode).toBe(404);
    });

    it('says so plainly when no secret is configured', async () => {
      await app.close();
      app = buildApp('');
      await app.ready();

      const res = await get(`/me/${token}`);
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain('switched off');
    });

    it('does not open a door to the admin panel', async () => {
      // A recipient token must not confer any admin access.
      for (const url of ['/', '/settings', '/audit']) {
        expect((await get(url)).statusCode).toBe(401);
      }
    });

    it('shows a recipient page without admin navigation', async () => {
      const res = await get(`/me/${token}`);
      expect(res.body).not.toContain('href="/settings"');
      expect(res.body).not.toContain('Sign out');
      expect(res.body).toContain('noindex');
    });
  });

  describe('muting one merge request', () => {
    it('shows a confirmation form rather than muting on a GET', async () => {
      // Mail scanners follow links; a GET must never change anything.
      const res = await get(`/me/${token}/mute?mr=${encodeURIComponent(MR)}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Rework the config loader');
      expect(res.body).toContain('Mute it');
      expect(repo.listUserMutes('alice')).toHaveLength(0);
    });

    it('offers every duration', async () => {
      const res = await get(`/me/${token}/mute?mr=${encodeURIComponent(MR)}`);
      for (const label of ['Until something changes', 'For 1 week', 'Until a date I choose', 'Permanently']) {
        expect(res.body).toContain(label);
      }
    });

    it('mutes permanently on confirmation and records who did it', async () => {
      const res = await post(`/me/${token}/mute`, { mr: MR, choice: 'forever' });
      expect(res.statusCode).toBe(200);

      const [mute] = repo.listUserMutes('alice');
      expect(mute).toMatchObject({ mode: 'forever', until: null, created_by: 'recipient' });

      const [entry] = audit.list({ action: 'mute.add' });
      expect(entry?.actor).toBe('recipient');
      expect(entry?.target).toBe(`alice:${MR}`);
    });

    it('mutes for a fixed period', async () => {
      await post(`/me/${token}/mute`, { mr: MR, choice: '1w' });
      const [mute] = repo.listUserMutes('alice');

      expect(mute?.mode).toBe('until');
      const days = (Date.parse(mute!.until!) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
    });

    it('captures a baseline for an until-it-changes mute', async () => {
      await post(`/me/${token}/mute`, { mr: MR, choice: 'until_change' });
      const [mute] = repo.listUserMutes('alice');

      expect(mute?.mode).toBe('until_change');
      expect(mute?.baseline).toMatchObject({ lastPushAt: '2026-08-01T00:00:00Z' });
    });

    it('sends the form back with a message when the date is missing or past', async () => {
      const res = await post(`/me/${token}/mute`, { mr: MR, choice: 'date' });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toContain('err=');
      expect(repo.listUserMutes('alice')).toHaveLength(0);

      const past = await post(`/me/${token}/mute`, { mr: MR, choice: 'date', date: '2020-01-01' });
      expect(past.headers.location).toContain('err=');
      expect(repo.listUserMutes('alice')).toHaveLength(0);
    });

    it('rejects a request with no merge request or no duration', async () => {
      expect((await post(`/me/${token}/mute`, { choice: 'forever' })).statusCode).toBe(400);
      expect((await post(`/me/${token}/mute`, { mr: MR })).statusCode).toBe(400);
      expect(repo.listUserMutes('alice')).toHaveLength(0);
    });

    it('normalises a merge request sub-page URL', async () => {
      await post(`/me/${token}/mute`, { mr: `${MR}/diffs`, choice: 'forever' });
      expect(repo.listUserMutes('alice')[0]?.mr_url).toBe(MR);
    });

    it('replaces an existing mute rather than duplicating it', async () => {
      await post(`/me/${token}/mute`, { mr: MR, choice: 'forever' });
      await post(`/me/${token}/mute`, { mr: MR, choice: '1d' });

      const mutes = repo.listUserMutes('alice');
      expect(mutes).toHaveLength(1);
      expect(mutes[0]?.mode).toBe('until');
    });

    it('mutes only for the person holding the token', async () => {
      repo.upsertRecipient({
        gitlab_username: 'bob',
        email: 'bob@example.com',
        teams_upn: null,
        channels: null,
        snooze_until: null,
      });

      await post(`/me/${token}/mute`, { mr: MR, choice: 'forever' });

      expect(repo.listUserMutes('alice')).toHaveLength(1);
      expect(repo.listUserMutes('bob')).toHaveLength(0);
      // And the global exclusion list is untouched, so nobody else goes quiet.
      expect(repo.listExclusions('muted_mr')).toHaveLength(0);
    });
  });

  describe('un-muting', () => {
    it('removes the mute and records it', async () => {
      await post(`/me/${token}/mute`, { mr: MR, choice: 'forever' });

      const res = await post(`/me/${token}/unmute`, { mr: MR });
      expect(res.statusCode).toBe(303);
      expect(repo.listUserMutes('alice')).toHaveLength(0);
      expect(audit.list({ action: 'mute.remove' })).toHaveLength(1);
    });

    it('lists an active mute with a way to undo it', async () => {
      await post(`/me/${token}/mute`, { mr: MR, choice: 'forever' });

      const res = await get(`/me/${token}`);
      expect(res.body).toContain('Rework the config loader');
      expect(res.body).toContain('Un-mute');
      expect(res.body).toContain('until you un-mute it');
    });

    it('shrugs off un-muting something that was never muted', async () => {
      expect((await post(`/me/${token}/unmute`, { mr: MR })).statusCode).toBe(303);
    });
  });

  describe('pausing everything', () => {
    it('snoozes for a fixed period', async () => {
      const res = await post(`/me/${token}/snooze`, { choice: '1w' });
      expect(res.statusCode).toBe(303);

      const snooze = repo.getRecipient('alice')?.snooze_until;
      expect(snooze).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const [entry] = audit.list({ action: 'snooze.set' });
      expect(entry?.actor).toBe('recipient');
    });

    it('snoozes until a chosen date', async () => {
      await post(`/me/${token}/snooze`, { choice: 'date', date: '2027-01-15' });
      expect(repo.getRecipient('alice')?.snooze_until).toBe('2027-01-15');
    });

    it('refuses a date that is not in the future', async () => {
      const res = await post(`/me/${token}/snooze`, { choice: 'date', date: '2020-01-01' });
      expect(res.statusCode).toBe(400);
      expect(repo.getRecipient('alice')?.snooze_until).toBeNull();
    });

    it('resumes on request', async () => {
      await post(`/me/${token}/snooze`, { choice: '1w' });
      await post(`/me/${token}/unsnooze`);

      expect(repo.getRecipient('alice')?.snooze_until).toBeNull();
      expect(audit.list({ action: 'snooze.clear' })).toHaveLength(1);
    });

    it('shows the pause state and an undo once snoozed', async () => {
      await post(`/me/${token}/snooze`, { choice: '1w' });
      const res = await get(`/me/${token}`);
      expect(res.body).toContain('Resume my reminders');
    });
  });

  describe('the page itself', () => {
    it('lists what is waiting, with a mute link for each', async () => {
      const res = await get(`/me/${token}`);
      expect(res.body).toContain('Rework the config loader');
      expect(res.body).toContain(`/me/${token}/mute?mr=`);
    });

    it('drops a muted merge request out of the waiting list', async () => {
      await post(`/me/${token}/mute`, { mr: MR, choice: 'forever' });
      const res = await get(`/me/${token}`);
      expect(res.body).toContain('Nothing is waiting for your input');
    });

    it('escapes a hostile merge request title', async () => {
      const runId = repo.startRun('cli', false);
      repo.finishRun(runId, { status: 'ok' });
      repo.replaceSnapshot(runId, [
        {
          gitlab_username: 'alice',
          mr_url: MR,
          mr_title: '<script>alert(1)</script>',
          project_path: 'a/b',
          author: 'dave',
          reasons: ['REVIEW_REQUESTED'],
          waiting_since: '2026-08-01T00:00:00Z',
          deliverable: true,
          skip_reason: null,
        },
      ]);

      const res = await get(`/me/${token}`);
      expect(res.body).not.toContain('<script>alert(1)</script>');
      expect(res.body).toContain('&lt;script&gt;');
    });

    it('copes with someone who has no snapshot yet', async () => {
      const carol = mintRecipientToken('carol', SECRET);
      const res = await get(`/me/${carol}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Hello carol');
    });
  });
});
