import { describe, expect, it } from 'vitest';
import type { GqlNote } from '../gitlab/types.js';
import { readyAt, type DraftAware } from './draft.js';

const CREATED = '2026-08-01T00:00:00Z';

function sys(body: string, createdAt: string, system = true): GqlNote {
  return { id: `n-${createdAt}`, body, createdAt, system, author: { username: 'bob', name: 'Bob' } };
}

function mr(notes: GqlNote[] = [], overrides: Partial<DraftAware> = {}): DraftAware {
  return { createdAt: CREATED, draft: false, notes: { nodes: notes }, ...overrides };
}

describe('readyAt', () => {
  it('falls back to creation for a merge request that was never a draft', () => {
    expect(readyAt(mr())).toBe(CREATED);
  });

  it('reads the ready transition out of the system notes', () => {
    const notes = [
      sys('marked this merge request as **draft**', '2026-08-01T00:00:00Z'),
      sys('marked this merge request as **ready**', '2026-08-11T09:00:00Z'),
    ];
    expect(readyAt(mr(notes))).toBe('2026-08-11T09:00:00Z');
  });

  it('understands the older Work In Progress wording', () => {
    const notes = [sys('unmarked as a **Work In Progress**', '2026-08-09T00:00:00Z')];
    expect(readyAt(mr(notes))).toBe('2026-08-09T00:00:00Z');
  });

  it('takes the last transition when a merge request went back to draft and out again', () => {
    const notes = [
      sys('marked this merge request as **ready**', '2026-08-03T00:00:00Z'),
      sys('marked this merge request as **draft**', '2026-08-05T00:00:00Z'),
      sys('marked this merge request as **ready**', '2026-08-08T00:00:00Z'),
    ];
    expect(readyAt(mr(notes))).toBe('2026-08-08T00:00:00Z');
  });

  it('ignores a human writing the same words in a comment', () => {
    const notes = [sys('marked this merge request as **ready**', '2026-08-09T00:00:00Z', false)];
    expect(readyAt(mr(notes))).toBe(CREATED);
  });

  it('falls back to creation while the merge request is still a draft', () => {
    const notes = [sys('marked this merge request as **ready**', '2026-08-03T00:00:00Z')];
    expect(readyAt(mr(notes, { draft: true }))).toBe(CREATED);
  });

  it('falls back to creation when the ready note has aged out of the window', () => {
    expect(readyAt(mr([sys('a comment', '2026-08-09T00:00:00Z', false)]))).toBe(CREATED);
    expect(readyAt({ createdAt: CREATED, draft: false })).toBe(CREATED);
  });
});
