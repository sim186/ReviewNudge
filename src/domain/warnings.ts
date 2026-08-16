import type { Rules } from '../config/schema.js';
import type { GqlMergeRequest } from '../gitlab/types.js';
import { isExcludedUser, type UserFilterOptions } from './filters.js';

/**
 * Warnings are facts about a merge request rather than about a person: nobody is
 * blocking it, it is simply not set up properly. They ride along on every digest row
 * for that merge request instead of forming rows of their own, so a reviewer who is
 * already being nudged learns that the merge request has no ticket without receiving
 * a second message about it.
 *
 * The one exception is a merge request nobody is on the hook for at all, which would
 * otherwise be invisible to everyone. See `authorShouldHear` below.
 */
export type WarningKind = 'NO_REVIEWER' | 'NO_TICKET';

export interface Warning {
  kind: WarningKind;
  /** One short sentence, shown inside the warning box. */
  detail: string;
}

/**
 * Compiled `ticket_pattern` values, keyed by the pattern text.
 *
 * A pattern that does not compile is stored as null so the failure is logged and
 * skipped once rather than on every merge request of every run.
 */
const patternCache = new Map<string, RegExp | null>();

/**
 * Compiles an operator-supplied ticket pattern, case-insensitively and without the
 * global flag — `g` would carry `lastIndex` between calls and make `test` alternate
 * between true and false on identical input.
 */
export function compileTicketPattern(pattern: string): RegExp | null {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) return cached;

  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(pattern, 'i');
  } catch {
    compiled = null;
  }
  patternCache.set(pattern, compiled);
  return compiled;
}

/** Exposed for tests, which need each case to compile afresh. */
export function clearTicketPatternCache(): void {
  patternCache.clear();
}

export interface WarningOptions {
  rules: Rules;
  userFilter: UserFilterOptions;
}

/**
 * Reviewers who could actually review: bots and excluded accounts do not count, so a
 * merge request whose only reviewer is a service account still reads as unattended.
 */
function humanReviewers(mr: GqlMergeRequest, userFilter: UserFilterOptions): number {
  return (mr.reviewers?.nodes ?? []).filter((r) => !isExcludedUser(r.username, r.bot, userFilter))
    .length;
}

export function hasTicketReference(mr: GqlMergeRequest, pattern: RegExp): boolean {
  return pattern.test(mr.title) || pattern.test(mr.description ?? '');
}

/**
 * Every warning that applies to this merge request.
 *
 * Drafts are never warned about: an unfinished merge request is expected to have no
 * reviewer and no ticket yet, and saying so daily is exactly the noise this tool
 * exists to remove.
 */
export function evaluateWarnings(mr: GqlMergeRequest, options: WarningOptions): Warning[] {
  const { rules, userFilter } = options;
  if (mr.draft) return [];

  const warnings: Warning[] = [];

  if (rules.warn_missing_reviewer && humanReviewers(mr, userFilter) === 0) {
    warnings.push({
      kind: 'NO_REVIEWER',
      detail: 'No reviewer is assigned, so nobody has been asked to look at this',
    });
  }

  if (rules.warn_missing_ticket) {
    const pattern = compileTicketPattern(rules.ticket_pattern);
    if (pattern && !hasTicketReference(mr, pattern)) {
      warnings.push({
        kind: 'NO_TICKET',
        detail: 'No issue key in the title or the description',
      });
    }
  }

  return warnings;
}

/**
 * Whether the author should be told directly.
 *
 * Only when the merge request produced no reasons at all — no reviewer waiting, no
 * assignee owing anything, no unresolved thread. That is the case the three rules
 * cannot see: an open merge request nobody is on the hook for, which sits there
 * indefinitely without appearing in a single digest. When somebody *is* on the hook,
 * their row already carries the warnings and the author is left alone.
 */
export function authorShouldHear(reasonCount: number, warnings: Warning[]): boolean {
  return reasonCount === 0 && warnings.length > 0;
}
