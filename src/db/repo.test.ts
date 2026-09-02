import { beforeEach, describe, expect, it } from 'vitest';
import { Audit } from './audit.js';
import { openDatabase, type Db } from './migrate.js';
import { Repo } from './repo.js';

describe('Repo', () => {
  let db: Db;
  let repo: Repo;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new Repo(db);
  });

  it('round-trips settings as JSON', () => {
    repo.setSetting('silence.quiet_hours', { start: '18:00', end: '08:00' });
    expect(repo.getSetting('silence.quiet_hours')).toEqual({ start: '18:00', end: '08:00' });

    repo.setSetting('silence.quiet_hours', null);
    expect(repo.getSetting('silence.quiet_hours')).toBeNull();

    repo.deleteSetting('silence.quiet_hours');
    expect(repo.getSetting('silence.quiet_hours')).toBeUndefined();
  });

  it('distinguishes a stored null from an absent key', () => {
    repo.setSetting('a', null);
    expect(repo.getSetting('a')).toBeNull();
    expect(repo.getSetting('b')).toBeUndefined();
  });

  it('refuses duplicate exclusions but allows the same pattern under another kind', () => {
    expect(repo.addExclusion('project', 'sandbox/**', null, 'admin')).not.toBeNull();
    expect(repo.addExclusion('project', 'sandbox/**', null, 'admin')).toBeNull();
    expect(repo.addExclusion('user', 'sandbox/**', null, 'admin')).not.toBeNull();
  });

  it('returns the removed exclusion so it can be audited', () => {
    const added = repo.addExclusion('mr_label', 'wip', 'noisy', 'admin')!;
    const removed = repo.removeExclusion(added.id);
    expect(removed?.pattern).toBe('wip');
    expect(repo.removeExclusion(added.id)).toBeNull();
  });

  it('seeds recipients once without clobbering later edits', () => {
    const seed = [
      {
        gitlab_username: 'alice',
        email: 'alice@example.com',
        teams_upn: null,
        channels: null,
        snooze_until: null,
      },
    ];
    expect(repo.seedRecipients(seed)).toBe(1);

    repo.upsertRecipient({
      gitlab_username: 'alice',
      email: 'changed@example.com',
      teams_upn: null,
      channels: ['teams'],
      snooze_until: '2026-09-01',
    });

    expect(repo.seedRecipients(seed)).toBe(0);
    const alice = repo.getRecipient('alice')!;
    expect(alice.email).toBe('changed@example.com');
    expect(alice.channels).toEqual(['teams']);
    expect(alice.snooze_until).toBe('2026-09-01');
  });

  it('tracks a run from start to finish', () => {
    const id = repo.startRun('manual', true);
    expect(repo.latestRun()?.status).toBe('running');
    expect(repo.latestRun()?.dry_run).toBe(true);

    repo.finishRun(id, { status: 'ok', mrs_scanned: 12, digests_sent: 3 });
    const run = repo.latestRun()!;
    expect(run.status).toBe('ok');
    expect(run.mrs_scanned).toBe(12);
    expect(run.digests_sent).toBe(3);
    expect(run.finished_at).not.toBeNull();
  });

  it('only reports completed runs as the latest usable snapshot source', () => {
    const done = repo.startRun('schedule', false);
    repo.finishRun(done, { status: 'ok' });
    repo.startRun('manual', false); // still running
    expect(repo.latestCompletedRun()?.id).toBe(done);
  });

  it('uses the latest live run as the participant activity boundary', () => {
    const live = repo.startRun('schedule', false);
    repo.finishRun(live, { status: 'ok' });
    const dry = repo.startRun('manual', true);
    repo.finishRun(dry, { status: 'ok' });
    expect(repo.latestNotificationRun()?.id).toBe(live);
  });

  it('replaces the snapshot atomically and prunes older ones', () => {
    const first = repo.startRun('cli', false);
    repo.replaceSnapshot(first, [
      {
        gitlab_username: 'alice',
        mr_url: 'https://gitlab.example.com/a/b/-/merge_requests/1',
        mr_title: 'Fix the thing',
        project_path: 'a/b',
        author: 'bob',
        reasons: ['REVIEW_REQUESTED'],
        waiting_since: '2026-08-01T00:00:00Z',
        deliverable: true,
        skip_reason: null,
      },
    ]);
    expect(repo.snapshotForRun(first)).toHaveLength(1);
    expect(repo.snapshotForRun(first)[0]?.reasons).toEqual(['REVIEW_REQUESTED']);

    repo.replaceSnapshot(first, []);
    expect(repo.snapshotForRun(first)).toHaveLength(0);

    const second = repo.startRun('cli', false);
    repo.replaceSnapshot(second, [
      {
        gitlab_username: 'carol',
        mr_url: 'https://gitlab.example.com/a/b/-/merge_requests/2',
        mr_title: 'Another',
        project_path: 'a/b',
        author: 'bob',
        reasons: ['UNRESOLVED_THREAD'],
        waiting_since: '2026-08-02T00:00:00Z',
        deliverable: false,
        skip_reason: 'no recipient mapping',
      },
    ]);
    repo.pruneOldSnapshots(second);
    expect(repo.snapshotForRun(first)).toHaveLength(0);
    expect(repo.snapshotForRun(second)[0]?.deliverable).toBe(false);
  });

  it('cascades snapshot deletion when a run is pruned', () => {
    const id = repo.startRun('cli', false);
    repo.replaceSnapshot(id, [
      {
        gitlab_username: 'alice',
        mr_url: 'u',
        mr_title: 't',
        project_path: 'p',
        author: null,
        reasons: [],
        waiting_since: '2026-01-01T00:00:00Z',
        deliverable: true,
        skip_reason: null,
      },
    ]);
    db.prepare(`UPDATE runs SET started_at = datetime('now', '-400 days') WHERE id = ?`).run(id);

    repo.prune(180, 90);
    expect(repo.snapshotForRun(id)).toHaveLength(0);
  });
});

describe('Audit', () => {
  let db: Db;
  let audit: Audit;

  beforeEach(() => {
    db = openDatabase(':memory:');
    audit = new Audit(db);
  });

  it('stores before/after as structured JSON', () => {
    audit.record({
      actor: 'admin',
      action: 'setting.update',
      target: 'rules.min_age_hours',
      before: 12,
      after: 48,
      sourceIp: '10.0.0.5',
    });
    const [row] = audit.list();
    expect(row?.before).toBe(12);
    expect(row?.after).toBe(48);
    expect(row?.source_ip).toBe('10.0.0.5');
    expect(row?.outcome).toBe('ok');
  });

  it('filters by actor and by action prefix', () => {
    audit.record({ actor: 'admin', action: 'exclusion.add', target: 'a' });
    audit.record({ actor: 'admin', action: 'exclusion.remove', target: 'a' });
    audit.record({ actor: 'scheduler', action: 'notification.send', target: 'alice' });

    expect(audit.list({ action: 'exclusion' })).toHaveLength(2);
    expect(audit.list({ actor: 'scheduler' })).toHaveLength(1);
    expect(audit.count({ action: 'notification' })).toBe(1);
    expect(audit.actions()).toEqual(['exclusion.add', 'exclusion.remove', 'notification.send']);
  });

  it('returns newest first and paginates', () => {
    for (let i = 0; i < 5; i++) {
      audit.record({ actor: 'admin', action: 'setting.update', target: `k${i}` });
    }
    expect(audit.list({ limit: 2 }).map((r) => r.target)).toEqual(['k4', 'k3']);
    expect(audit.list({ limit: 2, offset: 2 }).map((r) => r.target)).toEqual(['k2', 'k1']);
  });

  it('records failed deliveries alongside successful ones', () => {
    audit.record({
      actor: 'scheduler',
      action: 'notification.send',
      target: 'alice/email',
      outcome: 'error',
      detail: 'SMTP 550 mailbox unavailable',
    });
    const [row] = audit.list();
    expect(row?.outcome).toBe('error');
    expect(row?.detail).toContain('550');
  });
});
