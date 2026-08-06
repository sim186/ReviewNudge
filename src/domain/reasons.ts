import type { Rules } from '../config/schema.js';
import type {
  EnrichedMergeRequest,
  GqlDiscussion,
  GqlNote,
  GqlParticipant,
  ReviewState,
} from '../gitlab/types.js';
import { isExcludedUser, type UserFilterOptions } from './filters.js';

export type ReasonKind = 'REVIEW_REQUESTED' | 'ASSIGNEE_ACTION' | 'UNRESOLVED_THREAD';

export interface MergeRequestRef {
  url: string;
  title: string;
  projectPath: string;
  iid: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  labels: string[];
  /** Comment count, paired with lastPushAt to detect movement on a muted merge request. */
  notesCount: number | null;
}

export interface Reason {
  kind: ReasonKind;
  username: string;
  mr: MergeRequestRef;
  /** When the ball landed in this person's court. Drives ordering and "N days waiting". */
  waitingSince: string;
  /** One short sentence shown in the digest. */
  detail: string;
}

/**
 * Review states meaning the reviewer has not engaged with the current changes.
 * REVIEWED and REQUESTED_CHANGES are deliberately absent: in both the reviewer has
 * acted and the ball sits with the author until a new push arrives.
 */
const AWAITING_REVIEWER = new Set<ReviewState>(['UNREVIEWED', 'REVIEW_STARTED', 'UNAPPROVED']);

const MENTION = /(?:^|[^\w/])@([a-zA-Z0-9_][a-zA-Z0-9_.-]*[a-zA-Z0-9_]|[a-zA-Z0-9_])/g;

function isoMax(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function isAfter(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return Date.parse(a) > Date.parse(b);
}

/** The most recent push, falling back to updatedAt when commit data is unavailable. */
export function lastPushOf(mr: EnrichedMergeRequest): string | null {
  const commits = mr.commits?.nodes ?? [];
  let newest: string | null = null;
  for (const c of commits) {
    newest = isoMax(newest, c.committedDate ?? c.authoredDate ?? null);
  }
  return newest ?? mr.updatedAt ?? null;
}

function realNotes(notes: GqlNote[] | undefined): GqlNote[] {
  return (notes ?? []).filter((n) => !n.system && n.author?.username);
}

/** Latest non-system note by each user, across the merge request and its threads. */
export function buildActivityIndex(mr: EnrichedMergeRequest): Map<string, string> {
  const index = new Map<string, string>();
  const consider = (note: GqlNote) => {
    const who = note.author?.username;
    if (!who) return;
    const current = index.get(who) ?? null;
    const next = isoMax(current, note.createdAt);
    if (next) index.set(who, next);
  };

  for (const note of realNotes(mr.notes?.nodes)) consider(note);
  for (const discussion of mr.discussions.nodes) {
    for (const note of realNotes(discussion.notes.nodes)) consider(note);
  }
  return index;
}

export function mentionedUsernames(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION)) {
    const name = match[1];
    if (name && !['all', 'here', 'channel'].includes(name.toLowerCase())) found.add(name);
  }
  return [...found];
}

function toRef(mr: EnrichedMergeRequest, lastPushAt: string | null): MergeRequestRef {
  return {
    url: mr.webUrl,
    title: mr.title,
    projectPath: mr.projectPath,
    iid: mr.iid,
    author: mr.author?.username ?? null,
    createdAt: mr.createdAt,
    updatedAt: mr.updatedAt,
    lastPushAt,
    labels: mr.labels?.nodes.map((l) => l.title) ?? [],
    notesCount: mr.userNotesCount ?? null,
  };
}

function unresolvedThreads(mr: EnrichedMergeRequest): GqlDiscussion[] {
  return mr.discussions.nodes.filter((d) => d.resolvable && !d.resolved);
}

export interface EvaluateOptions {
  rules: Rules;
  userFilter: UserFilterOptions;
}

/**
 * Produces every reason a person is holding up this merge request.
 *
 * A person can collect more than one reason for the same merge request (assignee of
 * an approved merge request that also has an unresolved thread); the digest merges
 * them into a single row.
 */
export function evaluateMergeRequest(
  mr: EnrichedMergeRequest,
  options: EvaluateOptions,
): Reason[] {
  const { rules, userFilter } = options;
  const lastPushAt = lastPushOf(mr);
  const ref = toRef(mr, lastPushAt);
  const activity = buildActivityIndex(mr);
  const approvedBy = new Set((mr.approvedBy?.nodes ?? []).map((u) => u.username));
  const author = mr.author?.username ?? null;
  const reasons: Reason[] = [];

  const excluded = (p: { username: string; bot?: boolean | null }) =>
    isExcludedUser(p.username, p.bot, userFilter);

  const reviewers = mr.reviewers?.nodes ?? [];
  const assignees = mr.assignees?.nodes ?? [];
  const threads = unresolvedThreads(mr);

  if (rules.reviewer_not_approved) {
    for (const reviewer of reviewers) {
      const reason = reviewerReason(reviewer, {
        ref,
        approvedBy,
        author,
        activity,
        lastPushAt,
        rules,
      });
      if (reason && !excluded(reviewer)) reasons.push(reason);
    }
  }

  if (rules.assignee_action_pending) {
    for (const assignee of assignees) {
      if (excluded(assignee)) continue;
      const reason = assigneeReason(assignee, {
        mr,
        ref,
        reviewers,
        threads,
        activity,
        lastPushAt,
      });
      if (reason) reasons.push(reason);
    }
  }

  if (rules.unresolved_threads) {
    for (const reason of threadReasons(threads, ref, activity)) {
      if (!isExcludedUser(reason.username, null, userFilter)) reasons.push(reason);
    }
  }

  return reasons;
}

// ----------------------------------------------------------------- rule 1

interface ReviewerContext {
  ref: MergeRequestRef;
  approvedBy: Set<string>;
  author: string | null;
  activity: Map<string, string>;
  lastPushAt: string | null;
  rules: Rules;
}

function reviewerReason(reviewer: GqlParticipant, ctx: ReviewerContext): Reason | null {
  const username = reviewer.username;

  // Approving your own merge request is not a thing, and neither is reviewing it.
  if (username === ctx.author) return null;
  if (ctx.approvedBy.has(username)) return null;

  const state = reviewer.mergeRequestInteraction?.reviewState ?? null;
  if (state === 'APPROVED') return null;

  const lastActivity = ctx.activity.get(username) ?? null;

  // The reviewer has already responded to these changes. Only a newer push puts the
  // ball back in their court.
  if (state && !AWAITING_REVIEWER.has(state)) {
    if (!isAfter(ctx.lastPushAt, lastActivity)) return null;
    return {
      kind: 'REVIEW_REQUESTED',
      username,
      mr: ctx.ref,
      waitingSince: ctx.lastPushAt!,
      detail: 'New commits were pushed after your last review',
    };
  }

  // On instances too old for reviewState, absence from approvedBy is the only signal
  // available, which is why this branch also covers state === null.
  if (ctx.rules.require_activity_since_push && isAfter(lastActivity, ctx.lastPushAt)) {
    return null;
  }

  return {
    kind: 'REVIEW_REQUESTED',
    username,
    mr: ctx.ref,
    waitingSince: ctx.ref.createdAt,
    detail:
      state === 'UNAPPROVED'
        ? 'You withdrew your approval and have not re-reviewed'
        : 'Review requested — you have not approved yet',
  };
}

// ----------------------------------------------------------------- rule 2

interface AssigneeContext {
  mr: EnrichedMergeRequest;
  ref: MergeRequestRef;
  reviewers: GqlParticipant[];
  threads: GqlDiscussion[];
  activity: Map<string, string>;
  lastPushAt: string | null;
}

function assigneeReason(assignee: GqlParticipant, ctx: AssigneeContext): Reason | null {
  const username = assignee.username;
  const details: string[] = [];
  let waitingSince: string | null = null;

  // Changes requested: the assignee owes a fix, unless they have already pushed one.
  const changeRequesters = ctx.reviewers.filter(
    (r) => r.mergeRequestInteraction?.reviewState === 'REQUESTED_CHANGES',
  );
  const outstanding = changeRequesters.filter((r) => {
    const requestedAt = ctx.activity.get(r.username) ?? null;
    return !isAfter(ctx.lastPushAt, requestedAt);
  });
  if (outstanding.length > 0) {
    const names = outstanding.map((r) => `@${r.username}`).join(', ');
    details.push(`Changes requested by ${names}`);
    waitingSince = isoMax(
      waitingSince,
      outstanding.reduce<string | null>(
        (acc, r) => isoMax(acc, ctx.activity.get(r.username) ?? null),
        null,
      ),
    );
  }

  // Fully approved but still open: somebody has to press merge.
  const fullyApproved =
    ctx.mr.approved === true || (ctx.mr.approvalsLeft !== null && ctx.mr.approvalsLeft === 0);
  if (fullyApproved && (ctx.mr.approvedBy?.nodes.length ?? 0) > 0) {
    details.push('Approved and ready to merge');
    waitingSince = isoMax(waitingSince, ctx.mr.updatedAt);
  }

  // Unresolved threads opened by other people.
  const foreign = ctx.threads.filter((d) => {
    const notes = realNotes(d.notes.nodes);
    return notes.length > 0 && notes[0]!.author?.username !== username;
  });
  if (foreign.length > 0) {
    details.push(
      `${foreign.length} unresolved ${foreign.length === 1 ? 'thread' : 'threads'} from reviewers`,
    );
    waitingSince = isoMax(
      waitingSince,
      foreign.reduce<string | null>((acc, d) => {
        const notes = realNotes(d.notes.nodes);
        return isoMax(acc, notes[notes.length - 1]?.createdAt ?? null);
      }, null),
    );
  }

  if (details.length === 0) return null;

  return {
    kind: 'ASSIGNEE_ACTION',
    username,
    mr: ctx.ref,
    waitingSince: waitingSince ?? ctx.ref.updatedAt,
    detail: details.join('; '),
  };
}

// ----------------------------------------------------------------- rule 3

function threadReasons(
  threads: GqlDiscussion[],
  ref: MergeRequestRef,
  activity: Map<string, string>,
): Reason[] {
  // One reason per person, however many threads they are on the hook for.
  const owed = new Map<string, { count: number; since: string | null; mentioned: boolean }>();

  const owe = (username: string, since: string, mentioned: boolean) => {
    const current = owed.get(username);
    if (current) {
      current.count += 1;
      current.since = current.since && Date.parse(current.since) <= Date.parse(since)
        ? current.since
        : since;
      current.mentioned ||= mentioned;
    } else {
      owed.set(username, { count: 1, since, mentioned });
    }
  };

  for (const thread of threads) {
    const notes = realNotes(thread.notes.nodes);
    if (notes.length === 0) continue;

    const opener = notes[0]!.author!.username;
    const last = notes[notes.length - 1]!;
    const lastAuthor = last.author!.username;

    // Someone replied to a thread this person started, and they have not answered.
    if (lastAuthor !== opener) {
      owe(opener, last.createdAt, false);
    }

    // Mentioned and silent ever since.
    for (const note of notes) {
      const mentionedAt = note.createdAt;
      for (const username of mentionedUsernames(note.body)) {
        if (username === note.author?.username) continue;
        const acted = activity.get(username) ?? null;
        if (isAfter(acted, mentionedAt)) continue;
        owe(username, mentionedAt, true);
      }
    }
  }

  return [...owed.entries()].map(([username, info]) => ({
    kind: 'UNRESOLVED_THREAD' as const,
    username,
    mr: ref,
    waitingSince: info.since ?? ref.updatedAt,
    detail: info.mentioned
      ? `You were mentioned in ${info.count} unresolved ${info.count === 1 ? 'thread' : 'threads'}`
      : `${info.count} unresolved ${info.count === 1 ? 'thread you started is' : 'threads you started are'} awaiting your reply`,
  }));
}
