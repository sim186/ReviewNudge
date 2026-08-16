import type { Channel } from '../config/schema.js';
import type { RecipientRow } from '../db/repo.js';
import { addressFor } from '../notify/channels.js';
import type { MergeRequestRef, Reason, ReasonKind } from './reasons.js';
import { isSnoozed } from './silence.js';

export interface DigestItem {
  mr: MergeRequestRef;
  kinds: ReasonKind[];
  /** Earliest moment any of the merged reasons started waiting. */
  waitingSince: string;
  waitingDays: number;
  detail: string;
}

export interface Digest {
  username: string;
  recipient: RecipientRow;
  channels: Channel[];
  items: DigestItem[];
  /** Items before the per-digest cap was applied. */
  totalItems: number;
  truncated: number;
}

/** Somebody is blocking merge requests but cannot be reached. */
export interface UndeliverableGroup {
  username: string;
  itemCount: number;
  reason: 'no recipient mapping' | 'no channel configured' | 'disabled' | 'snoozed';
  items: DigestItem[];
}

export interface BuildDigestOptions {
  recipients: RecipientRow[];
  defaultChannels: Channel[];
  maxItemsPerDigest: number;
  timezone: string;
  now: Date;
  /** Channels that are actually configured; a recipient asking for others is trimmed. */
  availableChannels: Channel[];
  /** When a GitLab username has no explicit recipient entry, derive the email as `{username}@{domain}`. */
  defaultDomain?: string;
}

export interface DigestResult {
  digests: Digest[];
  undeliverable: UndeliverableGroup[];
}

const KIND_ORDER: ReasonKind[] = [
  'REVIEW_REQUESTED',
  'ASSIGNEE_ACTION',
  'UNRESOLVED_THREAD',
  // Last: a warning row is the least urgent thing in a digest, because nobody is
  // actually blocked by it.
  'MR_WARNING',
];

function daysBetween(fromIso: string, now: Date): number {
  const ms = now.getTime() - Date.parse(fromIso);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : 0;
}

/** Collapses every reason a person has on one merge request into a single row. */
function mergeReasons(reasons: Reason[], now: Date): DigestItem {
  const ordered = [...reasons].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
  const waitingSince = ordered.reduce(
    (earliest, r) => (Date.parse(r.waitingSince) < Date.parse(earliest) ? r.waitingSince : earliest),
    ordered[0]!.waitingSince,
  );

  return {
    mr: ordered[0]!.mr,
    kinds: [...new Set(ordered.map((r) => r.kind))],
    waitingSince,
    waitingDays: daysBetween(waitingSince, now),
    // De-duplicate identical sentences before joining, which happens when two rules
    // land on the same person for overlapping reasons.
    detail: [...new Set(ordered.map((r) => r.detail))].join('; '),
  };
}

function groupByUserAndMr(reasons: Reason[]): Map<string, Map<string, Reason[]>> {
  const byUser = new Map<string, Map<string, Reason[]>>();
  for (const reason of reasons) {
    let byMr = byUser.get(reason.username);
    if (!byMr) {
      byMr = new Map<string, Reason[]>();
      byUser.set(reason.username, byMr);
    }
    const key = mrKey(reason.mr);
    const list = byMr.get(key);
    if (list) list.push(reason);
    else byMr.set(key, [reason]);
  }
  return byUser;
}

function mrKey(mr: MergeRequestRef): string {
  return `${mr.projectPath}!${mr.iid}`;
}

/**
 * Turns a flat list of reasons into one digest per reachable person, plus an explicit
 * list of people we could not reach. The second list is what the panel shows at the
 * top of its Recipients page, so an unmapped blocker is visible rather than silently
 * dropped.
 */
export function buildDigests(reasons: Reason[], options: BuildDigestOptions): DigestResult {
  const byUsername = new Map(options.recipients.map((r) => [r.gitlab_username, r]));
  const digests: Digest[] = [];
  const undeliverable: UndeliverableGroup[] = [];

  for (const [username, byMr] of groupByUserAndMr(reasons)) {
    const items = [...byMr.values()]
      .map((group) => mergeReasons(group, options.now))
      // Longest-waiting first: the top of the message is the most overdue thing.
      .sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince));

    let recipient = byUsername.get(username);
    if (!recipient && options.defaultDomain) {
      const derivedAddress = `${username}@${options.defaultDomain}`;
      recipient = {
        gitlab_username: username,
        email: derivedAddress,
        teams_upn: derivedAddress,
        slack_id: null,
        telegram_chat_id: null,
        channels: null,
        snooze_until: null,
        enabled: true,
      };
    }
    if (!recipient) {
      undeliverable.push({ username, itemCount: items.length, reason: 'no recipient mapping', items });
      continue;
    }
    if (!recipient.enabled) {
      undeliverable.push({ username, itemCount: items.length, reason: 'disabled', items });
      continue;
    }
    if (isSnoozed(recipient.snooze_until, options.timezone, options.now)) {
      undeliverable.push({ username, itemCount: items.length, reason: 'snoozed', items });
      continue;
    }

    const channels = resolveChannels(recipient, options);
    if (channels.length === 0) {
      undeliverable.push({ username, itemCount: items.length, reason: 'no channel configured', items });
      continue;
    }

    const capped = items.slice(0, options.maxItemsPerDigest);
    digests.push({
      username,
      recipient,
      channels,
      items: capped,
      totalItems: items.length,
      truncated: items.length - capped.length,
    });
  }

  // Most overdue person first, so a partial delivery failure hits the least urgent.
  digests.sort((a, b) => Date.parse(a.items[0]!.waitingSince) - Date.parse(b.items[0]!.waitingSince));
  undeliverable.sort((a, b) => b.itemCount - a.itemCount);

  return { digests, undeliverable };
}

/**
 * A recipient's channel list narrowed to what is both globally enabled and actually
 * addressable — asking for Teams without a UPN silently delivers nothing otherwise.
 */
export function resolveChannels(
  recipient: RecipientRow,
  options: Pick<BuildDigestOptions, 'defaultChannels' | 'availableChannels'>,
): Channel[] {
  const requested = recipient.channels ?? options.defaultChannels;
  return requested.filter(
    (channel) => options.availableChannels.includes(channel) && Boolean(addressFor(recipient, channel)),
  );
}
