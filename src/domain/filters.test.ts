import { describe, expect, it } from 'vitest';
import { rulesSchema, excludeSchema } from '../config/schema.js';
import type { GqlMergeRequest } from '../gitlab/types.js';
import {
  filterMergeRequest,
  globToRegExp,
  isExcludedUser,
  isMuted,
  looksLikeBot,
  matchesAny,
  normaliseMrUrl,
} from './filters.js';

describe('globToRegExp', () => {
  const matches = (pattern: string, value: string) => globToRegExp(pattern).test(value);

  it('matches an exact path', () => {
    expect(matches('archive/legacy-tool', 'archive/legacy-tool')).toBe(true);
    expect(matches('archive/legacy-tool', 'archive/legacy-tool-2')).toBe(false);
  });

  it('keeps * inside a single segment', () => {
    expect(matches('sandbox/*', 'sandbox/alpha')).toBe(true);
    expect(matches('sandbox/*', 'sandbox/alpha/beta')).toBe(false);
  });

  it('spans segments with **', () => {
    expect(matches('sandbox/**', 'sandbox/alpha')).toBe(true);
    expect(matches('sandbox/**', 'sandbox/alpha/beta/gamma')).toBe(true);
  });

  it('lets a trailing /** also match the prefix itself', () => {
    // An operator excluding "sandbox/**" means the sandbox group too.
    expect(matches('sandbox/**', 'sandbox')).toBe(true);
    expect(matches('sandbox/**', 'sandboxed')).toBe(false);
  });

  it('is case-insensitive and escapes regex metacharacters', () => {
    expect(matches('Group/Sub', 'group/sub')).toBe(true);
    expect(matches('a.b', 'axb')).toBe(false);
    expect(matches('a+b', 'a+b')).toBe(true);
  });

  it('matches a bare ** against anything', () => {
    expect(matches('**', 'any/deep/path')).toBe(true);
  });
});

describe('user exclusion', () => {
  it('honours the GitLab bot flag', () => {
    expect(looksLikeBot('anything', true)).toBe(true);
  });

  it('recognises conventional bot names when the flag is absent', () => {
    expect(looksLikeBot('renovate-bot', null)).toBe(true);
    expect(looksLikeBot('release_bot', null)).toBe(true);
    expect(looksLikeBot('project_1234_bot', null)).toBe(true);
    expect(looksLikeBot('robert', null)).toBe(false);
  });

  it('keeps bots when bot exclusion is switched off', () => {
    const options = { excludedUsers: [], excludeBots: false };
    expect(isExcludedUser('renovate-bot', true, options)).toBe(false);
  });

  it('supports globs in the excluded user list', () => {
    const options = { excludedUsers: ['svc-*'], excludeBots: false };
    expect(isExcludedUser('svc-deploy', null, options)).toBe(true);
    expect(isExcludedUser('alice', null, options)).toBe(false);
  });

  it('matches usernames case-insensitively', () => {
    expect(matchesAny('Alice', ['alice'])).toBe(true);
  });
});

describe('normaliseMrUrl', () => {
  const base = 'https://gitlab.example.com/a/b/-/merge_requests/42';

  it('strips sub-pages, query strings, fragments and trailing slashes', () => {
    expect(normaliseMrUrl(`${base}/diffs`)).toBe(base);
    expect(normaliseMrUrl(`${base}/commits?foo=1`)).toBe(base);
    expect(normaliseMrUrl(`${base}#note_1`)).toBe(base);
    expect(normaliseMrUrl(`${base}/`)).toBe(base);
    expect(normaliseMrUrl(`  ${base}  `)).toBe(base);
  });

  it('matches a muted entry pasted from the browser address bar', () => {
    expect(isMuted(base, [`${base}/diffs`])).toBe(true);
    expect(isMuted(base, ['https://gitlab.example.com/a/b/-/merge_requests/43'])).toBe(false);
  });
});

function mr(overrides: Partial<GqlMergeRequest> = {}): GqlMergeRequest {
  return {
    id: 'gid://gitlab/MergeRequest/1',
    iid: '1',
    title: 'Fix the thing',
    webUrl: 'https://gitlab.example.com/a/b/-/merge_requests/1',
    draft: false,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-04T00:00:00Z',
    approved: false,
    approvalsLeft: 1,
    userDiscussionsCount: 0,
    resolvedDiscussionsCount: 0,
    project: { fullPath: 'a/b', archived: false },
    author: { username: 'bob', name: 'Bob' },
    labels: { nodes: [] },
    approvedBy: { nodes: [] },
    assignees: { nodes: [] },
    reviewers: { nodes: [] },
    commits: { nodes: [] },
    notes: { nodes: [] },
    ...overrides,
  };
}

describe('filterMergeRequest', () => {
  const now = new Date('2026-08-06T12:00:00Z');
  const options = {
    exclude: excludeSchema.parse({ projects: ['sandbox/**'], mr_labels: ['wip'], users: [] }),
    rules: rulesSchema.parse({}),
    mutedUrls: [],
    now,
  };

  it('includes an ordinary open merge request', () => {
    expect(filterMergeRequest(mr(), options)).toEqual({ included: true });
  });

  it('skips drafts only while ignore_draft is on', () => {
    expect(filterMergeRequest(mr({ draft: true }), options)).toEqual({
      included: false,
      reason: 'draft',
    });
    const keepDrafts = { ...options, rules: rulesSchema.parse({ ignore_draft: false }) };
    expect(filterMergeRequest(mr({ draft: true }), keepDrafts).included).toBe(true);
  });

  it('skips archived projects', () => {
    const decision = filterMergeRequest(
      mr({ project: { fullPath: 'a/b', archived: true } }),
      options,
    );
    expect(decision).toEqual({ included: false, reason: 'archived project' });
  });

  it('skips excluded projects and labels', () => {
    expect(
      filterMergeRequest(mr({ project: { fullPath: 'sandbox/toy', archived: false } }), options)
        .reason,
    ).toBe('excluded project');
    expect(
      filterMergeRequest(mr({ labels: { nodes: [{ title: 'WIP' }] } }), options).reason,
    ).toBe('excluded label');
  });

  it('skips muted merge requests', () => {
    const muted = { ...options, mutedUrls: ['https://gitlab.example.com/a/b/-/merge_requests/1'] };
    expect(filterMergeRequest(mr(), muted).reason).toBe('muted');
  });

  it('skips merge requests younger than min_age_hours', () => {
    const fresh = mr({ createdAt: '2026-08-06T06:00:00Z' }); // 6 hours old, threshold 12
    expect(filterMergeRequest(fresh, options).reason).toBe('too new');

    const noThreshold = { ...options, rules: rulesSchema.parse({ min_age_hours: 0 }) };
    expect(filterMergeRequest(fresh, noThreshold).included).toBe(true);
  });

  it('skips a merge request whose project could not be read', () => {
    expect(filterMergeRequest(mr({ project: null }), options).reason).toBe('no project');
  });
});
