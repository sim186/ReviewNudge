import { describe, expect, it } from 'vitest';
import type { UserMuteRow } from '../db/repo.js';
import {
  applyUserMutes,
  baselineOf,
  evaluateMute,
  findMuteChoice,
  hasChangedSince,
  indexMutes,
  resolveMuteChoice,
} from './mutes.js';
import type { MergeRequestRef, Reason } from './reasons.js';

const NOW = new Date('2026-08-10T09:00:00Z');

function ref(overrides: Partial<MergeRequestRef> = {}): MergeRequestRef {
  return {
    url: 'https://gitlab.example.com/a/b/-/merge_requests/1',
    title: 'Fix the thing',
    projectPath: 'a/b',
    iid: '1',
    author: 'dave',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-05T00:00:00Z',
    lastPushAt: '2026-08-05T00:00:00Z',
    labels: [],
    notesCount: 3,
    ...overrides,
  };
}

function reason(username: string, mr = ref()): Reason {
  return { kind: 'REVIEW_REQUESTED', username, mr, waitingSince: mr.createdAt, detail: 'Review' };
}

function mute(overrides: Partial<UserMuteRow> = {}): UserMuteRow {
  return {
    id: 1,
    gitlab_username: 'alice',
    mr_url: 'https://gitlab.example.com/a/b/-/merge_requests/1',
    mr_title: 'Fix the thing',
    mode: 'forever',
    until: null,
    baseline: null,
    created_at: '2026-08-06T00:00:00Z',
    created_by: 'recipient',
    ...overrides,
  };
}

describe('hasChangedSince', () => {
  const base = { lastPushAt: '2026-08-05T00:00:00Z', notesCount: 3 };

  it('detects a newer push', () => {
    expect(hasChangedSince(base, { lastPushAt: '2026-08-07T00:00:00Z', notesCount: 3 })).toBe(true);
  });

  it('detects a new comment', () => {
    expect(hasChangedSince(base, { lastPushAt: '2026-08-05T00:00:00Z', notesCount: 4 })).toBe(true);
  });

  it('reports no change when nothing moved', () => {
    expect(hasChangedSince(base, { ...base })).toBe(false);
  });

  it('ignores a comment being deleted', () => {
    expect(hasChangedSince(base, { lastPushAt: base.lastPushAt, notesCount: 1 })).toBe(false);
  });

  it('treats missing data as no change, so an uncertain comparison keeps the mute', () => {
    expect(hasChangedSince(base, { lastPushAt: null, notesCount: null })).toBe(false);
    expect(hasChangedSince(null, base)).toBe(false);
  });
});

describe('evaluateMute', () => {
  const current = { lastPushAt: '2026-08-05T00:00:00Z', notesCount: 3 };

  it('keeps a permanent mute active', () => {
    const decision = evaluateMute(mute({ mode: 'forever' }), current, NOW);
    expect(decision.suppresses).toBe(true);
    expect(decision.describe).toMatch(/un-mute/);
  });

  it('keeps a dated mute active before its expiry and drops it after', () => {
    const future = mute({ mode: 'until', until: '2026-08-20T00:00:00Z' });
    expect(evaluateMute(future, current, NOW).suppresses).toBe(true);

    const past = mute({ mode: 'until', until: '2026-08-01T00:00:00Z' });
    const decision = evaluateMute(past, current, NOW);
    expect(decision.suppresses).toBe(false);
    expect(decision.status).toBe('expired-time');
  });

  it('does not mute forever when a dated mute is malformed', () => {
    expect(evaluateMute(mute({ mode: 'until', until: null }), current, NOW).suppresses).toBe(false);
    expect(evaluateMute(mute({ mode: 'until', until: 'soon' }), current, NOW).suppresses).toBe(false);
  });

  it('ends an until-change mute once the merge request moves', () => {
    const m = mute({ mode: 'until_change', baseline: current });
    expect(evaluateMute(m, current, NOW).suppresses).toBe(true);

    const moved = { lastPushAt: '2026-08-09T00:00:00Z', notesCount: 3 };
    const decision = evaluateMute(m, moved, NOW);
    expect(decision.suppresses).toBe(false);
    expect(decision.status).toBe('expired-change');
  });
});

describe('applyUserMutes', () => {
  it('leaves reasons alone when nobody has muted anything', () => {
    const reasons = [reason('alice'), reason('bob')];
    const result = applyUserMutes(reasons, indexMutes([]), NOW);
    expect(result.kept).toHaveLength(2);
    expect(result.suppressed).toHaveLength(0);
  });

  it('suppresses only the muting person, never their colleagues', () => {
    // The whole point of personal mutes: alice going quiet must not silence bob.
    const reasons = [reason('alice'), reason('bob')];
    const result = applyUserMutes(reasons, indexMutes([mute({ gitlab_username: 'alice' })]), NOW);

    expect(result.kept.map((r) => r.username)).toEqual(['bob']);
    expect(result.suppressed.map((r) => r.username)).toEqual(['alice']);
  });

  it('only suppresses the merge request that was muted', () => {
    const other = ref({ url: 'https://gitlab.example.com/a/b/-/merge_requests/2', iid: '2' });
    const reasons = [reason('alice'), reason('alice', other)];
    const result = applyUserMutes(reasons, indexMutes([mute()]), NOW);

    expect(result.kept.map((r) => r.mr.iid)).toEqual(['2']);
    expect(result.suppressed.map((r) => r.mr.iid)).toEqual(['1']);
  });

  it('matches a mute stored with a sub-page URL', () => {
    const stored = mute({ mr_url: 'https://gitlab.example.com/a/b/-/merge_requests/1/diffs' });
    const result = applyUserMutes([reason('alice')], indexMutes([stored]), NOW);
    expect(result.suppressed).toHaveLength(1);
  });

  it('resumes notifying and reports the mute as expired once it lapses', () => {
    const lapsed = mute({ mode: 'until', until: '2026-08-01T00:00:00Z' });
    const result = applyUserMutes([reason('alice')], indexMutes([lapsed]), NOW);

    expect(result.kept).toHaveLength(1);
    expect(result.suppressed).toHaveLength(0);
    expect(result.expired).toEqual([
      { gitlab_username: 'alice', mr_url: lapsed.mr_url },
    ]);
  });

  it('reports an expired mute once even when several reasons share the merge request', () => {
    const lapsed = mute({ mode: 'until', until: '2026-08-01T00:00:00Z' });
    const reasons = [reason('alice'), { ...reason('alice'), kind: 'ASSIGNEE_ACTION' as const }];
    const result = applyUserMutes(reasons, indexMutes(lapsed ? [lapsed] : []), NOW);

    expect(result.kept).toHaveLength(2);
    expect(result.expired).toHaveLength(1);
  });
});

describe('resolveMuteChoice', () => {
  const options = { timezone: 'Europe/Zurich', now: NOW };

  it('turns a fixed period into a timestamp', () => {
    const choice = findMuteChoice('3d')!;
    const result = resolveMuteChoice(choice, options);
    expect(result).toEqual({ mode: 'until', until: '2026-08-13T09:00:00.000Z' });
  });

  it('passes through the modes that need no timestamp', () => {
    expect(resolveMuteChoice(findMuteChoice('forever')!, options)).toEqual({
      mode: 'forever',
      until: null,
    });
    expect(resolveMuteChoice(findMuteChoice('until_change')!, options)).toEqual({
      mode: 'until_change',
      until: null,
    });
  });

  it('takes a chosen date as the end of that day, so the date itself is included', () => {
    const result = resolveMuteChoice(findMuteChoice('date')!, { ...options, date: '2026-08-20' });
    // 23:59:59.999 on the 20th in Zurich is 21:59 UTC.
    expect(result).toMatchObject({ mode: 'until' });
    expect((result as { until: string }).until).toBe('2026-08-20T21:59:59.999Z');
  });

  it('rejects a missing, malformed, or past date', () => {
    const choice = findMuteChoice('date')!;
    expect(resolveMuteChoice(choice, options)).toEqual({ error: 'Pick a date.' });
    expect(resolveMuteChoice(choice, { ...options, date: 'whenever' })).toMatchObject({
      error: expect.stringContaining('not valid'),
    });
    expect(resolveMuteChoice(choice, { ...options, date: '2026-08-01' })).toMatchObject({
      error: expect.stringContaining('future'),
    });
  });

  it('rejects an unknown choice', () => {
    expect(findMuteChoice('forever-ish')).toBeNull();
  });
});

describe('baselineOf', () => {
  it('captures the fields used to detect movement', () => {
    expect(baselineOf(ref())).toEqual({ lastPushAt: '2026-08-05T00:00:00Z', notesCount: 3 });
  });
});
