import { beforeEach, describe, expect, it } from 'vitest';
import { rulesSchema } from '../config/schema.js';
import type { EnrichedMergeRequest, GqlParticipant, ReviewState } from '../gitlab/types.js';
import { evaluateMergeRequest } from './reasons.js';
import {
  authorShouldHear,
  clearTicketPatternCache,
  compileTicketPattern,
  evaluateWarnings,
} from './warnings.js';

const CREATED = '2026-08-01T00:00:00Z';
const PUSH = '2026-08-05T00:00:00Z';

function participant(username: string, state: ReviewState | null = null): GqlParticipant {
  return {
    username,
    name: username,
    bot: false,
    mergeRequestInteraction: state
      ? { approved: state === 'APPROVED', reviewed: state !== 'UNREVIEWED', reviewState: state }
      : null,
  };
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
    approvalsLeft: null,
    userNotesCount: 0,
    userDiscussionsCount: 0,
    resolvedDiscussionsCount: 0,
    project: { fullPath: 'a/b', archived: false },
    author: { username: 'author', name: 'Author', bot: false },
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

const userFilter = { excludedUsers: [] as string[], excludeBots: true };
const rules = (overrides: Partial<ReturnType<typeof rulesSchema.parse>> = {}) =>
  rulesSchema.parse(overrides);

const warn = (mr: EnrichedMergeRequest, overrides = {}) =>
  evaluateWarnings(mr, { rules: rules(overrides), userFilter }).map((w) => w.kind);

beforeEach(() => {
  clearTicketPatternCache();
});

describe('compileTicketPattern', () => {
  it('returns null for a pattern that does not compile, rather than throwing', () => {
    expect(compileTicketPattern('([A-Z]')).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(compileTicketPattern('PROJ-\\d+')!.test('proj-12')).toBe(true);
  });

  it('does not carry lastIndex between calls', () => {
    const pattern = compileTicketPattern('[A-Z][A-Z0-9]+-\\d+')!;
    expect(pattern.test('PROJ-1 done')).toBe(true);
    // A `g` flag here would make the second call start from the previous match.
    expect(pattern.test('PROJ-1 done')).toBe(true);
  });
});

describe('no reviewer', () => {
  it('warns when a non-draft merge request has nobody reviewing it', () => {
    expect(warn(buildMr())).toEqual(['NO_REVIEWER']);
  });

  it('stays quiet once a reviewer is assigned', () => {
    expect(warn(buildMr({ reviewers: { nodes: [participant('rev', 'UNREVIEWED')] } }))).toEqual([]);
  });

  it('still warns when the only reviewer is a bot', () => {
    const mr = buildMr({
      reviewers: { nodes: [{ ...participant('renovate-bot'), bot: true }] },
    });
    expect(warn(mr)).toEqual(['NO_REVIEWER']);
  });

  it('never warns about a draft, which is expected to be unfinished', () => {
    expect(warn(buildMr({ draft: true }))).toEqual([]);
  });

  it('is silenced by its own toggle', () => {
    expect(warn(buildMr(), { warn_missing_reviewer: false })).toEqual([]);
  });
});

describe('no ticket', () => {
  const on = { warn_missing_reviewer: false, warn_missing_ticket: true };

  it('is off unless switched on, because not every team has a tracker', () => {
    expect(warn(buildMr({ title: 'Fix the thing' }), { warn_missing_reviewer: false })).toEqual([]);
  });

  it('warns when neither the title nor the description carries a key', () => {
    expect(warn(buildMr({ title: 'Fix the thing', description: 'no key here' }), on)).toEqual([
      'NO_TICKET',
    ]);
  });

  it('accepts a key in the title', () => {
    expect(warn(buildMr({ title: 'PROJ-1234 fix the thing' }), on)).toEqual([]);
  });

  it('accepts a key in the description', () => {
    const mr = buildMr({ title: 'Fix the thing', description: 'Closes PROJ-1234.' });
    expect(warn(mr, on)).toEqual([]);
  });

  it('treats a missing description as empty rather than crashing', () => {
    expect(warn(buildMr({ title: 'Fix the thing', description: null }), on)).toEqual(['NO_TICKET']);
  });

  it('honours a custom pattern', () => {
    const mr = buildMr({ title: 'Fix the thing', description: 'see #4821' });
    expect(warn(mr, { ...on, ticket_pattern: '#\\d+' })).toEqual([]);
  });

  it('skips the check when the pattern does not compile', () => {
    const mr = buildMr({ title: 'Fix the thing' });
    expect(warn(mr, { ...on, ticket_pattern: '([A-Z]' })).toEqual([]);
  });
});

describe('authorShouldHear', () => {
  it('is true only when nobody is on the hook and something is wrong', () => {
    const warning = [{ kind: 'NO_REVIEWER' as const, detail: 'x' }];
    expect(authorShouldHear(0, warning)).toBe(true);
    expect(authorShouldHear(1, warning)).toBe(false);
    expect(authorShouldHear(0, [])).toBe(false);
  });
});

describe('warnings inside evaluateMergeRequest', () => {
  const evaluate = (mr: EnrichedMergeRequest, overrides = {}) =>
    evaluateMergeRequest(mr, { rules: rules(overrides), userFilter });

  it('gives the author a row when no reviewer and no assignee means nobody hears', () => {
    const reasons = evaluate(buildMr());
    expect(reasons.map((r) => `${r.username}:${r.kind}`)).toEqual(['author:MR_WARNING']);
    expect(reasons[0]!.mr.warnings.map((w) => w.kind)).toEqual(['NO_REVIEWER']);
    expect(reasons[0]!.waitingSince).toBe(CREATED);
  });

  it('leaves the author alone when somebody else is already being nudged', () => {
    const mr = buildMr({
      reviewers: { nodes: [participant('rev', 'UNREVIEWED')] },
      title: 'Fix the thing',
    });
    const reasons = evaluate(mr, { warn_missing_ticket: true });

    expect(reasons.map((r) => r.username)).toEqual(['rev']);
    // The warning still travels — on the reviewer's row, not as a second message.
    expect(reasons[0]!.mr.warnings.map((w) => w.kind)).toEqual(['NO_TICKET']);
  });

  it('warns the author when the only reviewer is excluded, so nobody is really looking', () => {
    const mr = buildMr({ reviewers: { nodes: [{ ...participant('renovate-bot'), bot: true }] } });
    expect(evaluate(mr).map((r) => `${r.username}:${r.kind}`)).toEqual(['author:MR_WARNING']);
  });

  it('does not nudge an author who is themselves excluded', () => {
    const mr = buildMr({ author: { username: 'ci-bot', name: 'CI', bot: true } });
    expect(evaluate(mr)).toEqual([]);
  });

  it('is silenced by notify_author_of_warnings without losing the warning itself', () => {
    const mr = buildMr({
      assignees: { nodes: [participant('author')] },
      discussions: {
        nodes: [
          {
            id: 'd1',
            resolvable: true,
            resolved: false,
            notes: {
              nodes: [
                {
                  id: 'n1',
                  body: 'please change this',
                  createdAt: '2026-08-06T00:00:00Z',
                  system: false,
                  author: { username: 'rev', name: 'Rev' },
                },
              ],
            },
          },
        ],
      },
    });
    const reasons = evaluate(mr, { notify_author_of_warnings: false });

    expect(reasons.some((r) => r.kind === 'MR_WARNING')).toBe(false);
    expect(reasons[0]!.mr.warnings.map((w) => w.kind)).toEqual(['NO_REVIEWER']);
  });

  it('adds no warnings at all to a draft', () => {
    const mr = buildMr({ draft: true, reviewers: { nodes: [] } });
    expect(evaluate(mr)).toEqual([]);
  });
});
