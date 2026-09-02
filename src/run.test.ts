import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigProvider } from './config/effective.js';
import { parseConfig } from './config/load.js';
import type { Channel } from './config/schema.js';
import { Audit } from './db/audit.js';
import { openDatabase, type Db } from './db/migrate.js';
import { Repo } from './db/repo.js';
import type { Digest } from './domain/digest.js';
import { GitLabClient } from './gitlab/client.js';
import type { GqlMergeRequest, GqlParticipant, ReviewState } from './gitlab/types.js';
import type { Notifier } from './notify/types.js';
import { executeRun } from './run.js';

const silent = pino({ level: 'silent' });
const DAY = 86_400_000;
const NOW = new Date('2026-08-10T09:00:00Z'); // a Monday
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

const yaml = `
gitlab:
  url: https://gitlab.example.com
  token: t
  groups: [engineering]
admin:
  enabled: false
schedule:
  timezone: UTC
silence:
  working_days: [mon, tue, wed, thu, fri, sat, sun]
notifications:
  channels: [email]
email:
  smtp: { host: smtp.example.com }
  from: nudge@example.com
recipients:
  - gitlab_username: alice
    email: alice@example.com
`;

function participant(username: string, reviewState: ReviewState | null = null): GqlParticipant {
  return {
    username,
    name: username,
    bot: false,
    mergeRequestInteraction: {
      approved: reviewState === 'APPROVED',
      reviewed: reviewState === 'REVIEWED',
      reviewState,
    },
  };
}

function mr(iid: string, overrides: Partial<GqlMergeRequest> = {}): GqlMergeRequest {
  return {
    id: `gid://gitlab/MergeRequest/${iid}`,
    iid,
    title: `MR ${iid}`,
    webUrl: `https://gitlab.example.com/engineering/core/-/merge_requests/${iid}`,
    draft: false,
    createdAt: ago(10),
    updatedAt: ago(3),
    approved: false,
    approvalsLeft: 1,
    userDiscussionsCount: 0,
    resolvedDiscussionsCount: 0,
    project: { fullPath: 'engineering/core', archived: false },
    author: { username: 'dave', name: 'Dave' },
    labels: { nodes: [] },
    approvedBy: { nodes: [] },
    assignees: { nodes: [] },
    reviewers: { nodes: [participant('alice', 'UNREVIEWED')] },
    commits: { nodes: [{ committedDate: ago(3), authoredDate: ago(3) }] },
    notes: { nodes: [] },
    ...overrides,
  };
}

/** A GitLabClient wired to a canned set of merge requests. */
function clientFor(nodes: GqlMergeRequest[]): GitLabClient {
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const { query } = JSON.parse(init.body as string);
    const data = query.includes('MergeRequestDiscussions')
      ? {
          project: {
            mergeRequest: {
              iid: '1',
              discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        }
      : {
          group: {
            id: 'gid://gitlab/Group/1',
            mergeRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
        };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return new GitLabClient({
    url: 'https://gitlab.example.com',
    token: 't',
    logger: silent,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

class RecordingNotifier implements Notifier {
  readonly sent: Digest[] = [];
  constructor(
    readonly channel: Channel,
    private readonly failWith?: string,
  ) {}

  async send(digest: Digest): Promise<void> {
    if (this.failWith) throw new Error(this.failWith);
    this.sent.push(digest);
  }
}

describe('executeRun', () => {
  let db: Db;
  let repo: Repo;
  let audit: Audit;

  function harness(configYaml = yaml) {
    const config = parseConfig(configYaml, 'test.yaml', {});
    repo.seedRecipients(config.recipients);
    return new ConfigProvider(config, repo, {});
  }

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new Repo(db);
    audit = new Audit(db);
  });

  it('scans, builds a digest and delivers it', async () => {
    const provider = harness();
    const notifier = new RecordingNotifier('email');

    const summary = await executeRun(provider, repo, audit, {
      trigger: 'cli',
      now: NOW,
      logger: silent,
      clientFactory: () => clientFor([mr('1')]),
      notifierFactory: () => new Map([['email', notifier]]),
    });

    expect(summary.status).toBe('ok');
    expect(summary.mrsScanned).toBe(1);
    expect(summary.reasonsFound).toBe(1);
    expect(summary.digestsSent).toBe(1);
    expect(notifier.sent[0]?.username).toBe('alice');
    expect(audit.list({ action: 'notification.send' })).toHaveLength(1);
  });

  it('emails all participants once when an MR has new activity', async () => {
    const provider = harness();
    repo.upsertRecipient({
      gitlab_username: 'bob',
      email: 'bob@example.com',
      teams_upn: null,
      channels: null,
      snooze_until: null,
    });
    const notifier = new RecordingNotifier('email');
    const activeMr = mr('1', {
      reviewers: { nodes: [] },
      participants: {
        nodes: [
          { username: 'alice', name: 'Alice' },
          { username: 'bob', name: 'Bob' },
        ],
      },
    });
    const run = (now: Date) =>
      executeRun(provider, repo, audit, {
        trigger: 'cli',
        now,
        logger: silent,
        clientFactory: () => clientFor([activeMr]),
        notifierFactory: () => new Map([['email', notifier]]),
      });

    await run(NOW);
    expect(notifier.sent.map((digest) => digest.username)).toEqual(['alice', 'bob']);

    notifier.sent.length = 0;
    await run(new Date(NOW.getTime() + 60_000));
    expect(notifier.sent).toHaveLength(0);
  });

  it('records the run and a snapshot the panel can read', async () => {
    const provider = harness();
    await executeRun(provider, repo, audit, {
      trigger: 'cli',
      now: NOW,
      logger: silent,
      clientFactory: () => clientFor([mr('1')]),
      notifierFactory: () => new Map([['email', new RecordingNotifier('email')]]),
    });

    const run = repo.latestCompletedRun()!;
    expect(run.status).toBe('ok');

    const snapshot = repo.snapshotForRun(run.id);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      gitlab_username: 'alice',
      reasons: ['REVIEW_REQUESTED'],
      deliverable: true,
    });
  });

  it('counts a merge request once when two groups both return it', async () => {
    const provider = harness(yaml.replace('groups: [engineering]', 'groups: [engineering, platform]'));
    const notifier = new RecordingNotifier('email');

    const summary = await executeRun(provider, repo, audit, {
      trigger: 'cli',
      now: NOW,
      logger: silent,
      clientFactory: () => clientFor([mr('1')]),
      notifierFactory: () => new Map([['email', notifier]]),
    });

    expect(summary.mrsScanned).toBe(1);
    expect(notifier.sent[0]?.items).toHaveLength(1);
  });

  it('skips the run entirely on a non-working day', async () => {
    const provider = harness(yaml.replace('working_days: [mon, tue, wed, thu, fri, sat, sun]', 'working_days: [sat]'));
    const notifier = new RecordingNotifier('email');

    const summary = await executeRun(provider, repo, audit, {
      trigger: 'schedule',
      now: NOW,
      logger: silent,
      clientFactory: () => clientFor([mr('1')]),
      notifierFactory: () => new Map([['email', notifier]]),
    });

    expect(summary.status).toBe('skipped');
    expect(summary.mrsScanned).toBe(0);
    expect(notifier.sent).toHaveLength(0);
    expect(audit.list({ action: 'run.skipped' })).toHaveLength(1);
  });

  it('still scans while paused, but withholds delivery', async () => {
    const provider = harness();
    repo.setSetting('silence.enabled', true);
    const notifier = new RecordingNotifier('email');

    const summary = await executeRun(provider, repo, audit, {
      trigger: 'schedule',
      now: NOW,
      logger: silent,
      clientFactory: () => clientFor([mr('1')]),
      notifierFactory: () => new Map([['email', notifier]]),
    });

    expect(summary.status).toBe('skipped');
    expect(summary.mrsScanned).toBe(1);
    expect(summary.digestsBuilt).toBe(1);
    expect(notifier.sent).toHaveLength(0);

    // The snapshot is still written, so the Pending page stays truthful while paused.
    const run = repo.latestRun()!;
    expect(repo.snapshotForRun(run.id)).toHaveLength(1);
    expect(audit.list({ action: 'run.held' })).toHaveLength(1);
  });

  it('applies an exclusion added through the panel', async () => {
    const provider = harness();
    repo.addExclusion('project', 'engineering/**', null, 'admin');
    const notifier = new RecordingNotifier('email');

    const summary = await executeRun(provider, repo, audit, {
      trigger: 'cli',
      now: NOW,
      logger: silent,
      clientFactory: () => clientFor([mr('1')]),
      notifierFactory: () => new Map([['email', notifier]]),
    });

    expect(summary.reasonsFound).toBe(0);
    expect(notifier.sent).toHaveLength(0);
  });

  it('drops a snoozed person into the undeliverable list', async () => {
    const provider = harness();
    repo.upsertRecipient({
      gitlab_username: 'alice',
      email: 'alice@example.com',
      teams_upn: null,
      channels: null,
      snooze_until: '2027-01-01',
    });
    const notifier = new RecordingNotifier('email');

    const summary = await executeRun(provider, repo, audit, {
      trigger: 'cli',
      now: NOW,
      logger: silent,
      clientFactory: () => clientFor([mr('1')]),
      notifierFactory: () => new Map([['email', notifier]]),
    });

    expect(notifier.sent).toHaveLength(0);
    expect(summary.undeliverable[0]).toMatchObject({ username: 'alice', reason: 'snoozed' });
  });

  it('reports an unmapped blocker without failing the run', async () => {
    const provider = harness();
    // Blocked on someone present in neither the database nor config.yaml. Deleting
    // alice would not do: ConfigProvider deliberately falls back to the file list
    // while the recipients table is empty.
    const notifier = new RecordingNotifier('email');

    const summary = await executeRun(provider, repo, audit, {
      trigger: 'cli',
      now: NOW,
      logger: silent,
      clientFactory: () =>
        clientFor([mr('1', { reviewers: { nodes: [participant('carol', 'UNREVIEWED')] } })]),
      notifierFactory: () => new Map([['email', notifier]]),
    });

    expect(summary.status).toBe('ok');
    expect(notifier.sent).toHaveLength(0);
    expect(summary.undeliverable[0]).toMatchObject({
      username: 'carol',
      reason: 'no recipient mapping',
    });

    // The snapshot still records it, so the panel can offer to map them.
    const snapshot = repo.snapshotForRun(repo.latestCompletedRun()!.id);
    expect(snapshot[0]).toMatchObject({
      gitlab_username: 'carol',
      deliverable: false,
      skip_reason: 'no recipient mapping',
    });
  });

  it('keeps going when one channel fails and marks the run partial', async () => {
    const provider = harness(yaml.replace('channels: [email]', 'channels: [email, teams]') + `
teams:
  workflow_url: https://example.logic.azure.com/workflows/abc
`);
    repo.upsertRecipient({
      gitlab_username: 'alice',
      email: 'alice@example.com',
      teams_upn: 'alice@example.com',
      channels: null,
      snooze_until: null,
    });

    const email = new RecordingNotifier('email', 'SMTP 550 mailbox unavailable');
    const teams = new RecordingNotifier('teams');

    const summary = await executeRun(provider, repo, audit, {
      trigger: 'cli',
      now: NOW,
      logger: silent,
      clientFactory: () => clientFor([mr('1')]),
      notifierFactory: () =>
        new Map<Channel, Notifier>([
          ['email', email],
          ['teams', teams],
        ]),
    });

    expect(summary.status).toBe('partial');
    expect(summary.failures).toBe(1);
    expect(summary.digestsSent).toBe(1); // Teams still got through.
    expect(teams.sent).toHaveLength(1);

    const failed = audit.list({ action: 'notification.send' }).filter((e) => e.outcome === 'error');
    expect(failed[0]?.detail).toContain('550');
  });

  it('drops an item the recipient muted, without touching anyone else', async () => {
    const provider = harness();
    repo.upsertRecipient({
      gitlab_username: 'bob',
      email: 'bob@example.com',
      teams_upn: null,
      channels: null,
      snooze_until: null,
    });
    repo.upsertUserMute({
      gitlab_username: 'alice',
      mr_url: 'https://gitlab.example.com/engineering/core/-/merge_requests/1',
      mr_title: 'MR 1',
      mode: 'forever',
      until: null,
      baseline: null,
    });

    const notifier = new RecordingNotifier('email');
    const summary = await executeRun(provider, repo, audit, {
      trigger: 'cli',
      now: NOW,
      logger: silent,
      clientFactory: () =>
        clientFor([
          mr('1', {
            reviewers: { nodes: [participant('alice', 'UNREVIEWED'), participant('bob', 'UNREVIEWED')] },
          }),
        ]),
      notifierFactory: () => new Map([['email', notifier]]),
    });

    expect(summary.personallyMuted).toBe(1);
    expect(notifier.sent.map((d) => d.username)).toEqual(['bob']);
  });

  it('still records a muted item in the snapshot, so it is not invisible', async () => {
    const provider = harness();
    repo.upsertUserMute({
      gitlab_username: 'alice',
      mr_url: 'https://gitlab.example.com/engineering/core/-/merge_requests/1',
      mr_title: 'MR 1',
      mode: 'forever',
      until: null,
      baseline: null,
    });

    await executeRun(provider, repo, audit, {
      trigger: 'cli',
      now: NOW,
      logger: silent,
      clientFactory: () => clientFor([mr('1')]),
      notifierFactory: () => new Map([['email', new RecordingNotifier('email')]]),
    });

    const snapshot = repo.snapshotForRun(repo.latestCompletedRun()!.id);
    expect(snapshot).toEqual([
      expect.objectContaining({
        gitlab_username: 'alice',
        deliverable: false,
        skip_reason: 'muted by recipient',
      }),
    ]);
  });

  it('resumes notifying and clears the mute once it lapses', async () => {
    const provider = harness();
    repo.upsertUserMute({
      gitlab_username: 'alice',
      mr_url: 'https://gitlab.example.com/engineering/core/-/merge_requests/1',
      mr_title: 'MR 1',
      mode: 'until',
      until: '2026-08-01T00:00:00Z', // already past at NOW
      baseline: null,
    });

    const notifier = new RecordingNotifier('email');
    const summary = await executeRun(provider, repo, audit, {
      trigger: 'cli',
      now: NOW,
      logger: silent,
      clientFactory: () => clientFor([mr('1')]),
      notifierFactory: () => new Map([['email', notifier]]),
    });

    expect(summary.personallyMuted).toBe(0);
    expect(notifier.sent).toHaveLength(1);
    // The lapsed row is tidied away rather than lingering forever.
    expect(repo.listUserMutes('alice')).toHaveLength(0);
  });

  it('ends an until-it-changes mute after a newer push', async () => {
    const provider = harness();
    repo.upsertUserMute({
      gitlab_username: 'alice',
      mr_url: 'https://gitlab.example.com/engineering/core/-/merge_requests/1',
      mr_title: 'MR 1',
      mode: 'until_change',
      until: null,
      baseline: { lastPushAt: ago(9), notesCount: 0 },
    });

    const notifier = new RecordingNotifier('email');
    await executeRun(provider, repo, audit, {
      trigger: 'cli',
      now: NOW,
      logger: silent,
      // The fixture pushes at ago(3), newer than the ago(9) baseline.
      clientFactory: () => clientFor([mr('1')]),
      notifierFactory: () => new Map([['email', notifier]]),
    });

    expect(notifier.sent).toHaveLength(1);
    expect(repo.listUserMutes('alice')).toHaveLength(0);
  });

  it('marks the run failed and rethrows when GitLab is unreachable', async () => {
    const provider = harness();
    const brokenClient = new GitLabClient({
      url: 'https://gitlab.example.com',
      token: 't',
      logger: silent,
      maxRetries: 0,
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });

    await expect(
      executeRun(provider, repo, audit, {
        trigger: 'schedule',
        now: NOW,
        logger: silent,
        clientFactory: () => brokenClient,
        notifierFactory: () => new Map(),
      }),
    ).rejects.toThrow();

    expect(repo.latestRun()?.status).toBe('failed');
    expect(audit.list({ action: 'run.failed' })).toHaveLength(1);
  });

  it('delivers nothing in a dry run but still records the scan', async () => {
    const provider = harness();
    const lines: string[] = [];

    const summary = await executeRun(provider, repo, audit, {
      trigger: 'cli',
      dryRun: true,
      now: NOW,
      logger: silent,
      clientFactory: () => clientFor([mr('1')]),
      // The default factory swaps in ConsoleNotifier for a dry run.
      notifierFactory: (config, dryRun) => {
        expect(dryRun).toBe(true);
        expect(config.notifications.channels).toEqual(['email']);
        return new Map<Channel, Notifier>([
          ['email', { channel: 'email', async send() { lines.push('printed'); } }],
        ]);
      },
    });

    expect(summary.dryRun).toBe(true);
    expect(lines).toEqual(['printed']);
    expect(repo.latestRun()?.dry_run).toBe(true);
  });
});
