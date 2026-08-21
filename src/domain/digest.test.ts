import { describe, expect, it } from 'vitest';
import type { RecipientRow } from '../db/repo.js';
import { buildDigests, resolveChannels, type BuildDigestOptions } from './digest.js';
import type { MergeRequestRef, Reason, ReasonKind } from './reasons.js';

const NOW = new Date('2026-08-10T09:00:00Z');

function ref(iid: string, project = 'a/b'): MergeRequestRef {
  return {
    url: `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    title: `MR ${iid}`,
    projectPath: project,
    iid,
    author: 'author',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-05T00:00:00Z',
    lastPushAt: '2026-08-05T00:00:00Z',
    labels: [],
  };
}

function reason(
  username: string,
  iid: string,
  kind: ReasonKind = 'REVIEW_REQUESTED',
  waitingSince = '2026-08-05T00:00:00Z',
  detail = 'Review requested',
): Reason {
  return { kind, username, mr: ref(iid), waitingSince, detail };
}

function recipient(overrides: Partial<RecipientRow> & { gitlab_username: string }): RecipientRow {
  return {
    email: `${overrides.gitlab_username}@example.com`,
    teams_upn: null,
    channels: null,
    snooze_until: null,
    enabled: true,
    ...overrides,
  };
}

function options(overrides: Partial<BuildDigestOptions> = {}): BuildDigestOptions {
  return {
    recipients: [recipient({ gitlab_username: 'alice' })],
    defaultChannels: ['email'],
    availableChannels: ['email'],
    maxItemsPerDigest: 25,
    timezone: 'Europe/Zurich',
    now: NOW,
    ...overrides,
  };
}

describe('buildDigests', () => {
  it('builds one digest per person', () => {
    const { digests } = buildDigests([reason('alice', '1')], options());
    expect(digests).toHaveLength(1);
    expect(digests[0]?.username).toBe('alice');
    expect(digests[0]?.items).toHaveLength(1);
    expect(digests[0]?.channels).toEqual(['email']);
  });

  it('merges several reasons for the same merge request into one row', () => {
    const reasons = [
      reason('alice', '1', 'ASSIGNEE_ACTION', '2026-08-06T00:00:00Z', 'Changes requested by @bob'),
      reason('alice', '1', 'UNRESOLVED_THREAD', '2026-08-04T00:00:00Z', '2 unresolved threads'),
    ];
    const { digests } = buildDigests(reasons, options());
    const item = digests[0]!.items[0]!;

    expect(digests[0]?.items).toHaveLength(1);
    expect(item.kinds).toEqual(['ASSIGNEE_ACTION', 'UNRESOLVED_THREAD']);
    // Waiting is measured from the earliest reason, not the latest.
    expect(item.waitingSince).toBe('2026-08-04T00:00:00Z');
    expect(item.detail).toBe('Changes requested by @bob; 2 unresolved threads');
  });

  it('de-duplicates identical detail sentences', () => {
    const reasons = [
      reason('alice', '1', 'REVIEW_REQUESTED', '2026-08-05T00:00:00Z', 'Review requested'),
      reason('alice', '1', 'ASSIGNEE_ACTION', '2026-08-05T00:00:00Z', 'Review requested'),
    ];
    expect(buildDigests(reasons, options()).digests[0]?.items[0]?.detail).toBe('Review requested');
  });

  it('keeps merge requests from different projects apart', () => {
    const reasons = [
      { ...reason('alice', '1'), mr: ref('1', 'a/b') },
      { ...reason('alice', '1'), mr: ref('1', 'c/d') },
    ];
    expect(buildDigests(reasons, options()).digests[0]?.items).toHaveLength(2);
  });

  it('sorts items longest-waiting first and computes whole days', () => {
    const reasons = [
      reason('alice', '1', 'REVIEW_REQUESTED', '2026-08-09T09:00:00Z'),
      reason('alice', '2', 'REVIEW_REQUESTED', '2026-08-01T09:00:00Z'),
    ];
    const items = buildDigests(reasons, options()).digests[0]!.items;
    expect(items.map((i) => i.mr.iid)).toEqual(['2', '1']);
    expect(items[0]?.waitingDays).toBe(9);
    expect(items[1]?.waitingDays).toBe(1);
  });

  it('sorts digests so the most overdue person comes first', () => {
    const reasons = [
      reason('alice', '1', 'REVIEW_REQUESTED', '2026-08-09T09:00:00Z'),
      reason('bob', '2', 'REVIEW_REQUESTED', '2026-08-01T09:00:00Z'),
    ];
    const opts = options({
      recipients: [recipient({ gitlab_username: 'alice' }), recipient({ gitlab_username: 'bob' })],
    });
    expect(buildDigests(reasons, opts).digests.map((d) => d.username)).toEqual(['bob', 'alice']);
  });

  it('caps a long digest and reports how much was cut', () => {
    const reasons = Array.from({ length: 5 }, (_, i) => reason('alice', String(i)));
    const { digests } = buildDigests(reasons, options({ maxItemsPerDigest: 3 }));
    expect(digests[0]?.items).toHaveLength(3);
    expect(digests[0]?.totalItems).toBe(5);
    expect(digests[0]?.truncated).toBe(2);
  });

  it('reports an unmapped blocker rather than dropping them', () => {
    const { digests, undeliverable } = buildDigests([reason('carol', '1')], options());
    expect(digests).toHaveLength(0);
    expect(undeliverable).toEqual([
      expect.objectContaining({ username: 'carol', reason: 'no recipient mapping', itemCount: 1 }),
    ]);
  });

  it('uses the GitLab public email when no explicit mapping exists', () => {
    const opts = options({ gitlabEmails: new Map([['carol', 'carol.ren@example.com']]) });
    const { digests } = buildDigests([reason('carol', '1')], opts);
    expect(digests).toHaveLength(1);
    expect(digests[0]?.recipient.email).toBe('carol.ren@example.com');
  });

  it('prefers the explicit mapping over the GitLab public email', () => {
    const opts = options({
      gitlabEmails: new Map([['alice', 'wrong@example.com']]),
    });
    const { digests } = buildDigests([reason('alice', '1')], opts);
    expect(digests[0]?.recipient.email).toBe('alice@example.com');
  });

  it('falls back to the derived domain when GitLab has no public email', () => {
    const opts = options({
      defaultDomain: 'example.com',
      gitlabEmails: new Map([['carol', null]]),
    });
    const { digests } = buildDigests([reason('carol', '1')], opts);
    expect(digests).toHaveLength(1);
    expect(digests[0]?.recipient.email).toBe('carol@example.com');
  });

  it('reports a snoozed person separately from an unmapped one', () => {
    const opts = options({
      recipients: [recipient({ gitlab_username: 'alice', snooze_until: '2026-09-01' })],
    });
    const { digests, undeliverable } = buildDigests([reason('alice', '1')], opts);
    expect(digests).toHaveLength(0);
    expect(undeliverable[0]?.reason).toBe('snoozed');
  });

  it('reports a disabled recipient', () => {
    const opts = options({ recipients: [recipient({ gitlab_username: 'alice', enabled: false })] });
    expect(buildDigests([reason('alice', '1')], opts).undeliverable[0]?.reason).toBe('disabled');
  });

  it('reports a recipient with no usable channel', () => {
    const opts = options({
      recipients: [recipient({ gitlab_username: 'alice', email: null })],
    });
    expect(buildDigests([reason('alice', '1')], opts).undeliverable[0]?.reason).toBe(
      'no channel configured',
    );
  });

  it('orders undeliverable groups by how much they are blocking', () => {
    const reasons = [reason('carol', '1'), reason('carol', '2'), reason('dave', '3')];
    const { undeliverable } = buildDigests(reasons, options());
    expect(undeliverable.map((u) => u.username)).toEqual(['carol', 'dave']);
  });
});

describe('resolveChannels', () => {
  const opts = { defaultChannels: ['email', 'teams'] as const, availableChannels: ['email', 'teams'] as const };

  it('falls back to the global channel list', () => {
    const r = recipient({ gitlab_username: 'alice', teams_upn: 'alice@example.com' });
    expect(resolveChannels(r, { ...opts, defaultChannels: [...opts.defaultChannels], availableChannels: [...opts.availableChannels] })).toEqual(['email', 'teams']);
  });

  it('honours a per-person override', () => {
    const r = recipient({ gitlab_username: 'alice', teams_upn: 'alice@example.com', channels: ['teams'] });
    expect(resolveChannels(r, { defaultChannels: ['email'], availableChannels: ['email', 'teams'] })).toEqual(['teams']);
  });

  it('drops a channel the person has no address for', () => {
    const r = recipient({ gitlab_username: 'alice', teams_upn: null });
    expect(resolveChannels(r, { defaultChannels: ['email', 'teams'], availableChannels: ['email', 'teams'] })).toEqual(['email']);
  });

  it('drops a channel that is not configured globally', () => {
    const r = recipient({ gitlab_username: 'alice', teams_upn: 'alice@example.com' });
    expect(resolveChannels(r, { defaultChannels: ['email', 'teams'], availableChannels: ['email'] })).toEqual(['email']);
  });
});
