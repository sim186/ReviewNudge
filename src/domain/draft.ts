import type { GqlMergeRequest } from '../gitlab/types.js';

/**
 * GitLab publishes no "left draft at" timestamp — not on the REST merge request and
 * not in GraphQL — so the transition has to be read back out of the system notes.
 * Two wordings are in the wild: current instances write "marked this merge request
 * as **ready**", instances predating the draft rename used the Work In Progress
 * phrasing. System notes are never localised, so matching English is safe.
 */
const READY_NOTE =
  /^(?:marked this merge request as \*\*ready\*\*|unmarked as a \*\*work in progress\*\*)/i;

/** Everything readyAt needs; the group query already selects all of it. */
export type DraftAware = Pick<GqlMergeRequest, 'createdAt' | 'draft' | 'notes'>;

/**
 * When the merge request last became something people are expected to act on.
 *
 * This is the honest start of the clock for anything phrased as waiting: a merge
 * request that spent ten days as a draft has been anyone's problem for the two days
 * since it went ready, not twelve. It also keeps `min_age_hours` meaningful, which a
 * creation-anchored age lets drafts skip entirely.
 *
 * Falls back to `createdAt` when there is nothing better to go on: the merge request
 * was never a draft, is a draft right now, or its ready note has aged out of the
 * notes window. The fallback is the pre-existing behaviour, so it can only be as
 * wrong as before, never more so.
 */
export function readyAt(mr: DraftAware): string {
  if (mr.draft) return mr.createdAt;

  // Latest wins: a merge request can be pushed back to draft and readied again.
  let newest: string | null = null;
  for (const note of mr.notes?.nodes ?? []) {
    if (!note.system || !READY_NOTE.test(note.body)) continue;
    if (!newest || Date.parse(note.createdAt) > Date.parse(newest)) newest = note.createdAt;
  }
  return newest ?? mr.createdAt;
}
