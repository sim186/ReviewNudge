import type { Exclusions, Rules } from '../config/schema.js';
import type { GqlMergeRequest } from '../gitlab/types.js';

/**
 * Compiles a glob to a regular expression.
 *
 * `*` matches within one path segment, `**` matches across segments. A trailing
 * `/**` also matches the prefix itself, so `sandbox/**` covers both the `sandbox`
 * group and everything beneath it — that is what an operator typing it expects.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;

    if (char === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble) {
        // "/**" at the end (or before another slash) may also match nothing at all.
        if (out.endsWith('/') && (i + 2 === pattern.length || pattern[i + 2] === '/')) {
          out = `${out.slice(0, -1)}(?:/.*)?`;
        } else {
          out += '.*';
        }
        i++;
      } else {
        out += '[^/]*';
      }
      continue;
    }

    out += /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${out}$`, 'i');
}

const globCache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  let re = globCache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    globCache.set(pattern, re);
  }
  return re;
}

export function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => compile(p).test(value));
}

/** GitLab marks service accounts with `bot`; names ending in -bot are a good hint too. */
export function looksLikeBot(username: string, botFlag: boolean | null | undefined): boolean {
  if (botFlag) return true;
  return /(^|[-_])bot$/i.test(username) || username.startsWith('project_');
}

export interface UserFilterOptions {
  excludedUsers: readonly string[];
  excludeBots: boolean;
}

export function isExcludedUser(
  username: string,
  botFlag: boolean | null | undefined,
  options: UserFilterOptions,
): boolean {
  if (options.excludeBots && looksLikeBot(username, botFlag)) return true;
  return matchesAny(username, options.excludedUsers);
}

export type SkipReason =
  | 'draft'
  | 'archived project'
  | 'excluded project'
  | 'excluded label'
  | 'muted'
  | 'too new'
  | 'no project';

export interface FilterDecision {
  included: boolean;
  reason?: SkipReason;
}

export interface MergeRequestFilterOptions {
  exclude: Exclusions;
  rules: Pick<Rules, 'ignore_draft' | 'min_age_hours'>;
  mutedUrls: readonly string[];
  now: Date;
}

/**
 * Decides whether a merge request is in scope at all, before any per-user rules run.
 *
 * Returning the reason rather than a bare boolean lets the admin panel explain why a
 * merge request the operator expected to see is absent.
 */
export function filterMergeRequest(
  mr: GqlMergeRequest,
  options: MergeRequestFilterOptions,
): FilterDecision {
  const projectPath = mr.project?.fullPath;
  if (!projectPath) return { included: false, reason: 'no project' };
  if (mr.project?.archived) return { included: false, reason: 'archived project' };
  if (options.rules.ignore_draft && mr.draft) return { included: false, reason: 'draft' };

  if (matchesAny(projectPath, options.exclude.projects)) {
    return { included: false, reason: 'excluded project' };
  }

  const labels = mr.labels?.nodes.map((l) => l.title) ?? [];
  if (labels.some((label) => matchesAny(label, options.exclude.mr_labels))) {
    return { included: false, reason: 'excluded label' };
  }

  if (isMuted(mr.webUrl, options.mutedUrls)) {
    return { included: false, reason: 'muted' };
  }

  const ageHours = (options.now.getTime() - Date.parse(mr.createdAt)) / 3_600_000;
  if (Number.isFinite(ageHours) && ageHours < options.rules.min_age_hours) {
    return { included: false, reason: 'too new' };
  }

  return { included: true };
}

/**
 * Mute entries are compared as normalised URLs so a trailing slash, a `/diffs`
 * suffix, or a copied link with query parameters still matches what the operator
 * pasted into the panel.
 */
export function isMuted(webUrl: string, mutedUrls: readonly string[]): boolean {
  const target = normaliseMrUrl(webUrl);
  return mutedUrls.some((u) => normaliseMrUrl(u) === target);
}

export function normaliseMrUrl(url: string): string {
  const trimmed = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  // Strip merge request sub-pages such as /diffs, /commits, /pipelines.
  const match = /^(.*\/-\/merge_requests\/\d+)(?:\/.*)?$/.exec(trimmed);
  return (match?.[1] ?? trimmed).toLowerCase();
}
