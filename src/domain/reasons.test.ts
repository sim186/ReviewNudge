import { describe, expect, it } from 'vitest';
import { rulesSchema } from '../config/schema.js';
import type {
  EnrichedMergeRequest,
  GqlDiscussion,
  GqlNote,
  GqlParticipant,
  ReviewState,
} from '../gitlab/types.js';
import { evaluateMergeRequest, lastPushOf, mentionedUsernames } from './reasons.js';

const CREATED = '2026-08-01T00:00:00Z';
const PUSH = '2026-08-03T00:00:00Z';

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

function note(author: string, createdAt: string, body = 'a comment', system = false): GqlNote {
  return { id: `n-${author}-${createdAt}`, body, createdAt, system, author: { username: author, name: author } };
}

function thread(notes: GqlNote[], resolved = false): GqlDiscussion {
  return { id: `d-${notes[0]?.id ?? 'x'}`, resolvable: true, resolved, notes: { nodes: notes } };
}

function buildMr(overrides: Partial<EnrichedMergeRequest> = {}): EnrichedMergeRequest {
  return {
    id: 'gid://gitlab/MergeRequest/1',
    iid: '1',
    title: 'Fix the thing',
    webUrl: 'https://gitlab.example.com/a/b/-/merge_requests/1',
    projectPath: 'a/b',
    draft: false,
    createdAt: CREATED,
    updatedAt: PUSH,
    approved: false,
    approvalsLeft: 1,
    userDiscussionsCount: 0,
    resolvedDiscussionsCount: 0,
    project: { fullPath: 'a/b', archived: false },
    author: { username: 'author', name: 'Author' },
    labels: { nodes: [] },
    approvedBy: { nodes: [] },
    assignees: { nodes: [] },
    reviewers: { nodes: [] },
    commits: { nodes: [{ committedDate: PUSH, authoredDate: PUSH }] },
    notes: { nodes: [] },
    discussions: { nodes: [] },
    ...overrides,
  };
}

/**
 * The author fallback is off by default here so these tests stay about the three
 * blocking rules. Most fixtures have no reviewer, which would otherwise hand every
 * one of them an extra MR_WARNING row. warnings.test.ts covers it instead.
 */
const options = (rules: Partial<ReturnType<typeof rulesSchema.parse>> = {}) => ({
  rules: rulesSchema.parse({ notify_author_of_warnings: false, ...rules }),
  userFilter: { excludedUsers: [], excludeBots: true },
});

const kinds = (mr: EnrichedMergeRequest, opts = options()) =>
  evaluateMergeRequest(mr, opts).map((r) => `${r.username}:${r.kind}`);

describe('lastPushOf', () => {
  it('takes the newest commit date regardless of connection ordering', () => {
    const mr = buildMr({
      commits: {
        nodes: [
          { committedDate: '2026-08-01T00:00:00Z', authoredDate: null },
          { committedDate: '2026-08-05T00:00:00Z', authoredDate: null },
        ],
      },
    });
    expect(lastPushOf(mr)).toBe('2026-08-05T00:00:00Z');
  });

  it('falls back to authoredDate, then to updatedAt', () => {
    expect(lastPushOf(buildMr({ commits: { nodes: [{ committedDate: null, authoredDate: PUSH }] } }))).toBe(PUSH);
    expect(lastPushOf(buildMr({ commits: { nodes: [] }, updatedAt: '2026-08-09T00:00:00Z' }))).toBe(
      '2026-08-09T00:00:00Z',
    );
  });
});

describe('mentionedUsernames', () => {
  it('extracts handles and ignores group aliases', () => {
    expect(mentionedUsernames('ping @alice and @bob.smith please')).toEqual(['alice', 'bob.smith']);
    expect(mentionedUsernames('@all @here hello')).toEqual([]);
  });

  it('ignores email addresses and paths', () => {
    expect(mentionedUsernames('mail alice@example.com')).toEqual([]);
    expect(mentionedUsernames('see docs/@internal')).toEqual([]);
  });

  it('does not swallow a trailing period as part of the handle', () => {
    expect(mentionedUsernames('thanks @alice.')).toEqual(['alice']);
  });
});

describe('rule 1: reviewer has not approved', () => {
  it('flags an unreviewed reviewer', () => {
    const mr = buildMr({ reviewers: { nodes: [participant('rev', 'UNREVIEWED')] } });
    const [reason] = evaluateMergeRequest(mr, options());
    expect(reason).toMatchObject({
      username: 'rev',
      kind: 'REVIEW_REQUESTED',
      waitingSince: CREATED,
    });
    expect(reason?.detail).toMatch(/have not approved/);
  });

  it('waits from the ready transition, not from creation, on a former draft', () => {
    const READY = '2026-08-09T00:00:00Z';
    const mr = buildMr({
      reviewers: { nodes: [participant('rev', 'UNREVIEWED')] },
      notes: {
        nodes: [note('author', READY, 'marked this merge request as **ready**', true)],
      },
    });
    const [reason] = evaluateMergeRequest(mr, options());
    // Eight days as a draft are not eight days the reviewer kept anyone waiting.
    expect(reason?.waitingSince).toBe(READY);
  });

  it('stays quiet once the reviewer has approved', () => {
    const mr = buildMr({
      reviewers: { nodes: [participant('rev', 'APPROVED')] },
      approvedBy: { nodes: [{ username: 'rev', name: 'Rev' }] },
    });
    expect(kinds(mr)).toEqual([]);
  });

  it('trusts approvedBy even when reviewState disagrees', () => {
    const mr = buildMr({
      reviewers: { nodes: [participant('rev', 'UNREVIEWED')] },
      approvedBy: { nodes: [{ username: 'rev', name: 'Rev' }] },
    });
    expect(kinds(mr)).toEqual([]);
  });

  it('treats a withdrawn approval as pending, with its own wording', () => {
    const mr = buildMr({ reviewers: { nodes: [participant('rev', 'UNAPPROVED')] } });
    expect(evaluateMergeRequest(mr, options())[0]?.detail).toMatch(/withdrew your approval/);
  });

  it('does not chase a reviewer who commented without approving', () => {
    // REVIEWED means the ball is with the author until new commits land.
    const mr = buildMr({
      reviewers: { nodes: [participant('rev', 'REVIEWED')] },
      notes: { nodes: [note('rev', '2026-08-04T00:00:00Z')] },
    });
    expect(kinds(mr)).toEqual([]);
  });

  it('chases that reviewer again after a newer push', () => {
    const mr = buildMr({
      reviewers: { nodes: [participant('rev', 'REVIEWED')] },
      notes: { nodes: [note('rev', '2026-08-02T00:00:00Z')] },
      commits: { nodes: [{ committedDate: '2026-08-05T00:00:00Z', authoredDate: null }] },
    });
    const [reason] = evaluateMergeRequest(mr, options());
    expect(reason).toMatchObject({ username: 'rev', waitingSince: '2026-08-05T00:00:00Z' });
    expect(reason?.detail).toMatch(/New commits were pushed/);
  });

  it('never asks the author to review their own merge request', () => {
    const mr = buildMr({ reviewers: { nodes: [participant('author', 'UNREVIEWED')] } });
    expect(kinds(mr)).toEqual([]);
  });

  it('skips a reviewer who already commented since the last push', () => {
    const mr = buildMr({
      reviewers: { nodes: [participant('rev', 'UNREVIEWED')] },
      notes: { nodes: [note('rev', '2026-08-04T00:00:00Z')] },
    });
    expect(kinds(mr)).toEqual([]);
  });

  it('keeps that reviewer when require_activity_since_push is off', () => {
    const mr = buildMr({
      reviewers: { nodes: [participant('rev', 'UNREVIEWED')] },
      notes: { nodes: [note('rev', '2026-08-04T00:00:00Z')] },
    });
    expect(kinds(mr, options({ require_activity_since_push: false }))).toEqual(['rev:REVIEW_REQUESTED']);
  });

  it('falls back to approvedBy on instances without reviewState', () => {
    const legacy: GqlParticipant = {
      username: 'rev',
      name: 'Rev',
      bot: false,
      mergeRequestInteraction: { approved: false, reviewed: false, reviewState: null },
    };
    expect(kinds(buildMr({ reviewers: { nodes: [legacy] } }))).toEqual(['rev:REVIEW_REQUESTED']);
  });

  it('excludes bots and configured users', () => {
    const mr = buildMr({
      reviewers: {
        nodes: [
          { ...participant('renovate-bot', 'UNREVIEWED'), bot: true },
          participant('ignored', 'UNREVIEWED'),
        ],
      },
    });
    const opts = { ...options(), userFilter: { excludedUsers: ['ignored'], excludeBots: true } };
    expect(kinds(mr, opts)).toEqual([]);
  });

  it('is silenced entirely by the rule toggle', () => {
    const mr = buildMr({ reviewers: { nodes: [participant('rev', 'UNREVIEWED')] } });
    expect(kinds(mr, options({ reviewer_not_approved: false }))).toEqual([]);
  });
});

describe('rule 2: assignee has something to do', () => {
  it('flags changes requested that have not been addressed', () => {
    const mr = buildMr({
      assignees: { nodes: [participant('author')] },
      reviewers: { nodes: [participant('rev', 'REQUESTED_CHANGES')] },
      notes: { nodes: [note('rev', '2026-08-04T00:00:00Z')] },
    });
    const reason = evaluateMergeRequest(mr, options()).find((r) => r.kind === 'ASSIGNEE_ACTION');
    expect(reason?.username).toBe('author');
    expect(reason?.detail).toMatch(/Changes requested by @rev/);
    expect(reason?.waitingSince).toBe('2026-08-04T00:00:00Z');
  });

  it('clears changes requested once a newer commit lands', () => {
    const mr = buildMr({
      assignees: { nodes: [participant('author')] },
      reviewers: { nodes: [participant('rev', 'REQUESTED_CHANGES')] },
      notes: { nodes: [note('rev', '2026-08-02T00:00:00Z')] },
      commits: { nodes: [{ committedDate: '2026-08-05T00:00:00Z', authoredDate: null }] },
    });
    expect(kinds(mr).filter((k) => k.endsWith('ASSIGNEE_ACTION'))).toEqual([]);
  });

  it('flags a fully approved merge request nobody merged', () => {
    const mr = buildMr({
      assignees: { nodes: [participant('author')] },
      approved: true,
      approvalsLeft: 0,
      approvedBy: { nodes: [{ username: 'rev', name: 'Rev' }] },
    });
    const reason = evaluateMergeRequest(mr, options()).find((r) => r.kind === 'ASSIGNEE_ACTION');
    expect(reason?.detail).toMatch(/ready to merge/);
  });

  it('does not claim readiness when nobody has actually approved', () => {
    // approvalsLeft is 0 on projects with no approval rules configured.
    const mr = buildMr({
      assignees: { nodes: [participant('author')] },
      approved: true,
      approvalsLeft: 0,
      approvedBy: { nodes: [] },
    });
    expect(kinds(mr)).toEqual([]);
  });

  it('flags unresolved threads opened by other people', () => {
    const mr = buildMr({
      assignees: { nodes: [participant('author')] },
      discussions: { nodes: [thread([note('rev', '2026-08-04T00:00:00Z', 'please change this')])] },
    });
    const reason = evaluateMergeRequest(mr, options()).find((r) => r.kind === 'ASSIGNEE_ACTION');
    expect(reason?.detail).toMatch(/1 unresolved thread from reviewers/);
  });

  it('ignores threads the assignee opened themselves', () => {
    const mr = buildMr({
      assignees: { nodes: [participant('author')] },
      discussions: { nodes: [thread([note('author', '2026-08-04T00:00:00Z')])] },
    });
    expect(kinds(mr).filter((k) => k.endsWith('ASSIGNEE_ACTION'))).toEqual([]);
  });

  it('ignores resolved threads', () => {
    const mr = buildMr({
      assignees: { nodes: [participant('author')] },
      discussions: { nodes: [thread([note('rev', '2026-08-04T00:00:00Z')], true)] },
    });
    expect(kinds(mr).filter((k) => k.endsWith('ASSIGNEE_ACTION'))).toEqual([]);
  });

  it('combines several triggers into one reason', () => {
    const mr = buildMr({
      assignees: { nodes: [participant('author')] },
      reviewers: { nodes: [participant('rev', 'REQUESTED_CHANGES')] },
      notes: { nodes: [note('rev', '2026-08-04T00:00:00Z')] },
      discussions: { nodes: [thread([note('rev', '2026-08-04T00:00:00Z')])] },
    });
    const reason = evaluateMergeRequest(mr, options()).find((r) => r.kind === 'ASSIGNEE_ACTION');
    expect(reason?.detail).toMatch(/Changes requested by @rev; 1 unresolved thread/);
  });

  it('is silenced entirely by the rule toggle', () => {
    const mr = buildMr({
      assignees: { nodes: [participant('author')] },
      reviewers: { nodes: [participant('rev', 'REQUESTED_CHANGES')] },
      notes: { nodes: [note('rev', '2026-08-04T00:00:00Z')] },
    });
    expect(kinds(mr, options({ assignee_action_pending: false })).filter((k) => k.includes('ASSIGNEE'))).toEqual([]);
  });
});

describe('rule 3: unresolved threads', () => {
  it('flags the thread opener once somebody replies', () => {
    const mr = buildMr({
      discussions: {
        nodes: [
          thread([
            note('alice', '2026-08-04T00:00:00Z', 'why this?'),
            note('bob', '2026-08-05T00:00:00Z', 'because of X'),
          ]),
        ],
      },
    });
    const reason = evaluateMergeRequest(mr, options()).find((r) => r.kind === 'UNRESOLVED_THREAD');
    expect(reason).toMatchObject({ username: 'alice', waitingSince: '2026-08-05T00:00:00Z' });
    expect(reason?.detail).toMatch(/awaiting your reply/);
  });

  it('does not chase the opener while they had the last word', () => {
    const mr = buildMr({
      discussions: { nodes: [thread([note('alice', '2026-08-04T00:00:00Z')])] },
    });
    expect(kinds(mr).filter((k) => k.endsWith('UNRESOLVED_THREAD'))).toEqual([]);
  });

  it('flags a mentioned user who never answered', () => {
    const mr = buildMr({
      discussions: { nodes: [thread([note('alice', '2026-08-04T00:00:00Z', 'what do you think @carol?')])] },
    });
    const reason = evaluateMergeRequest(mr, options()).find((r) => r.username === 'carol');
    expect(reason?.detail).toMatch(/mentioned in 1 unresolved thread/);
  });

  it('lets a mentioned user off once they reply', () => {
    const mr = buildMr({
      discussions: {
        nodes: [
          thread([
            note('alice', '2026-08-04T00:00:00Z', '@carol thoughts?'),
            note('carol', '2026-08-05T00:00:00Z', 'looks fine'),
          ]),
        ],
      },
    });
    expect(evaluateMergeRequest(mr, options()).find((r) => r.username === 'carol')).toBeUndefined();
  });

  it('counts several threads into a single reason per person', () => {
    const mr = buildMr({
      discussions: {
        nodes: [
          thread([note('alice', '2026-08-04T00:00:00Z'), note('bob', '2026-08-05T00:00:00Z')]),
          thread([note('alice', '2026-08-04T12:00:00Z'), note('bob', '2026-08-06T00:00:00Z')]),
        ],
      },
    });
    const forAlice = evaluateMergeRequest(mr, options()).filter((r) => r.username === 'alice');
    expect(forAlice).toHaveLength(1);
    expect(forAlice[0]?.detail).toMatch(/2 unresolved threads/);
    // Waiting time is measured from the oldest outstanding thread, not the newest.
    expect(forAlice[0]?.waitingSince).toBe('2026-08-05T00:00:00Z');
  });

  it('ignores system notes when deciding who spoke last', () => {
    const mr = buildMr({
      discussions: {
        nodes: [
          thread([
            note('alice', '2026-08-04T00:00:00Z'),
            note('bob', '2026-08-05T00:00:00Z'),
            note('gitlab', '2026-08-06T00:00:00Z', 'changed the description', true),
          ]),
        ],
      },
    });
    const reason = evaluateMergeRequest(mr, options()).find((r) => r.kind === 'UNRESOLVED_THREAD');
    expect(reason?.username).toBe('alice');
  });

  it('ignores non-resolvable threads', () => {
    const mr = buildMr({
      discussions: {
        nodes: [
          {
            id: 'd1',
            resolvable: false,
            resolved: false,
            notes: { nodes: [note('alice', '2026-08-04T00:00:00Z'), note('bob', '2026-08-05T00:00:00Z')] },
          },
        ],
      },
    });
    expect(kinds(mr).filter((k) => k.endsWith('UNRESOLVED_THREAD'))).toEqual([]);
  });

  it('is silenced entirely by the rule toggle', () => {
    const mr = buildMr({
      discussions: {
        nodes: [thread([note('alice', '2026-08-04T00:00:00Z'), note('bob', '2026-08-05T00:00:00Z')])],
      },
    });
    expect(kinds(mr, options({ unresolved_threads: false }))).toEqual([]);
  });
});

describe('combined behaviour', () => {
  it('can hold one person accountable on two counts for the same merge request', () => {
    const mr = buildMr({
      assignees: { nodes: [participant('author')] },
      reviewers: { nodes: [participant('rev', 'REQUESTED_CHANGES')] },
      notes: { nodes: [note('rev', '2026-08-04T00:00:00Z')] },
      discussions: {
        nodes: [thread([note('author', '2026-08-04T00:00:00Z'), note('rev', '2026-08-05T00:00:00Z')])],
      },
    });
    expect(kinds(mr).sort()).toEqual(['author:ASSIGNEE_ACTION', 'author:UNRESOLVED_THREAD']);
  });

  it('produces nothing for a merge request that is genuinely idle', () => {
    const mr = buildMr({
      reviewers: { nodes: [participant('rev', 'APPROVED')] },
      approvedBy: { nodes: [{ username: 'rev', name: 'Rev' }] },
      assignees: { nodes: [] },
    });
    expect(kinds(mr)).toEqual([]);
  });
});
