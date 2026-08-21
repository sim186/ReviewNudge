import type { ConfigProvider, EffectiveConfig } from './config/effective.js';
import type { Channel } from './config/schema.js';
import type { Audit } from './db/audit.js';
import type { Repo, RunTrigger, SnapshotItem } from './db/repo.js';
import { buildDigests, type Digest, type DigestResult } from './domain/digest.js';
import { filterMergeRequest } from './domain/filters.js';
import { evaluateMergeRequest, type Reason } from './domain/reasons.js';
import { applyUserMutes, indexMutes } from './domain/mutes.js';
import { describeSilence, evaluateRunSilence } from './domain/silence.js';
import { GitLabClient } from './gitlab/client.js';
import type { EnrichedMergeRequest, GqlMergeRequest } from './gitlab/types.js';
import { logger as rootLogger, type Logger } from './logger.js';
import { availableChannels, buildNotifiers } from './notify/factory.js';
import { renderDigest, type SelfServiceLinks } from './notify/render.js';
import { manageLink, mintRecipientToken, muteLink, selfServiceBaseUrl } from './notify/tokens.js';
import type { Notifier } from './notify/types.js';

export { buildNotifiers } from './notify/factory.js';

export interface RunOptions {
  trigger: RunTrigger;
  dryRun?: boolean;
  /** Ignore silencing and deliver anyway. Used by `test-notify`, never by the scheduler. */
  force?: boolean;
  now?: Date;
  logger?: Logger;
  clientFactory?: (config: EffectiveConfig) => GitLabClient;
  notifierFactory?: (config: EffectiveConfig, dryRun: boolean) => Map<Channel, Notifier>;
  /** Signs the per-recipient links in a digest. Omit to leave the links out. */
  selfServiceSecret?: string;
  /** Restrict the scan to these project full paths (e.g. "group/project"). */
  projectFilter?: readonly string[];
}

export interface RunSummary {
  runId: number;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  skippedReason?: string;
  mrsScanned: number;
  reasonsFound: number;
  digestsBuilt: number;
  digestsSent: number;
  failures: number;
  /** Reasons dropped because the person muted that merge request for themselves. */
  personallyMuted: number;
  undeliverable: DigestResult['undeliverable'];
  dryRun: boolean;
}


function toSnapshotItems(result: DigestResult): SnapshotItem[] {
  const items: SnapshotItem[] = [];

  const push = (
    username: string,
    digestItems: Digest['items'],
    deliverable: boolean,
    skipReason: string | null,
  ) => {
    for (const item of digestItems) {
      items.push({
        gitlab_username: username,
        mr_url: item.mr.url,
        mr_title: item.mr.title,
        project_path: item.mr.projectPath,
        author: item.mr.author,
        reasons: item.kinds,
        waiting_since: item.waitingSince,
        deliverable,
        skip_reason: skipReason,
      });
    }
  };

  for (const digest of result.digests) push(digest.username, digest.items, true, null);
  for (const group of result.undeliverable) push(group.username, group.items, false, group.reason);

  return items;
}

/** Muted items still appear on the Pending page, flagged, so nothing goes invisible. */
function mutedSnapshotItems(suppressed: Reason[]): SnapshotItem[] {
  const seen = new Set<string>();
  const items: SnapshotItem[] = [];

  for (const reason of suppressed) {
    const key = `${reason.username} ${reason.mr.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      gitlab_username: reason.username,
      mr_url: reason.mr.url,
      mr_title: reason.mr.title,
      project_path: reason.mr.projectPath,
      author: reason.mr.author,
      reasons: [reason.kind],
      waiting_since: reason.waitingSince,
      deliverable: false,
      skip_reason: 'muted by recipient',
    });
  }
  return items;
}

/**
 * One complete cycle: scan GitLab, work out who is blocking what, and deliver.
 *
 * The snapshot and run record are written even when nothing is sent, so the admin
 * panel can show the current state while paused and the audit log explains why a
 * quiet day was quiet.
 */
export async function executeRun(
  provider: ConfigProvider,
  repo: Repo,
  audit: Audit,
  options: RunOptions,
): Promise<RunSummary> {
  const log = options.logger ?? rootLogger;
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const config = provider.resolve();

  const silence = evaluateRunSilence(config.silence, config.schedule.timezone, now);
  if (silence.silenced && !silence.scanAnyway && !options.force) {
    const runId = repo.startRun(options.trigger, dryRun);
    const reason = describeSilence(silence);
    repo.finishRun(runId, { status: 'skipped', skipped_reason: reason });
    audit.record({
      actor: options.trigger === 'schedule' ? 'scheduler' : 'cli',
      action: 'run.skipped',
      target: String(runId),
      detail: reason,
    });
    log.info({ reason }, 'run skipped');
    return {
      runId,
      status: 'skipped',
      skippedReason: reason,
      mrsScanned: 0,
      reasonsFound: 0,
      digestsBuilt: 0,
      digestsSent: 0,
      failures: 0,
      personallyMuted: 0,
      undeliverable: [],
      dryRun,
    };
  }

  const runId = repo.startRun(options.trigger, dryRun);
  const client =
    options.clientFactory?.(config) ??
    new GitLabClient({
      url: config.gitlab.url,
      token: config.gitlab.token,
      timeoutMs: config.gitlab.timeout_ms,
      pageSize: config.gitlab.page_size,
      maxRetries: config.gitlab.max_retries,
      // Only the missing-ticket warning reads descriptions, and they are the most
      // expensive field on the query.
      includeDescription: config.rules.warn_missing_ticket,
      logger: log,
    });

  try {
    // ---------------------------------------------------------------- scan
    const raw: GqlMergeRequest[] = [];
    for (const group of config.gitlab.groups) {
      raw.push(...(await client.fetchGroupMergeRequests(group, config.gitlab.include_subgroups)));
    }

    // A merge request visible through two groups must not be counted twice.
    let unique = new Map(raw.map((mr) => [mr.id, mr]));

    // Build a project whitelist from config + CLI (CLI flag further narrows config).
    const configProjects = config.gitlab.projects;
    const cliProjects = options.projectFilter && options.projectFilter.length > 0
      ? options.projectFilter
      : null;
    const projectWhitelist = cliProjects ?? (configProjects.length > 0 ? configProjects : null);

    if (projectWhitelist) {
      const allowed = new Set(projectWhitelist);
      unique = new Map(
        [...unique.entries()].filter(([, mr]) =>
          allowed.has(mr.project?.fullPath ?? ''),
        ),
      );
      log.debug({ kept: unique.size, filter: [...allowed] }, 'applied project filter');
    }

    const filterOptions = {
      exclude: config.exclude,
      rules: config.rules,
      mutedUrls: config.silence.muted_merge_requests,
      now,
    };
    const inScope = [...unique.values()].filter(
      (mr) => filterMergeRequest(mr, filterOptions).included,
    );

    // Filtering first means excluded merge requests never cost a discussions request.
    const enriched: EnrichedMergeRequest[] = await client.enrich(inScope, () => true);

    // -------------------------------------------------------------- reason
    const userFilter = { excludedUsers: config.exclude.users, excludeBots: config.exclude.bots };
    const allReasons: Reason[] = enriched.flatMap((mr) =>
      evaluateMergeRequest(mr, { rules: config.rules, userFilter }),
    );

    // --------------------------------------------------------- personal mutes
    // Applied after the rules so the reasons themselves stay honest: the merge
    // request really is waiting on this person, they have just asked not to hear
    // about it. Only their own digest is affected.
    const muteResult = applyUserMutes(allReasons, indexMutes(repo.allUserMutes()), now);
    const reasons = muteResult.kept;

    if (muteResult.expired.length > 0) {
      repo.deleteExpiredUserMutes(muteResult.expired);
      log.info({ count: muteResult.expired.length }, 'personal mutes lapsed; notifying again');
    }
    if (muteResult.suppressed.length > 0) {
      log.debug({ count: muteResult.suppressed.length }, 'items suppressed by personal mutes');
    }

    // ------------------------------------------------------- email fallback lookup
    // Only usernames without an explicit mapping cost a GitLab request; everyone else
    // is already reachable exactly as configured.
    const unmappedUsernames = [...new Set(reasons.map((r) => r.username))].filter(
      (u) => !config.recipients.some((r) => r.gitlab_username === u),
    );
    const gitlabEmails =
      unmappedUsernames.length > 0
        ? await client.fetchUserEmails(unmappedUsernames)
        : new Map<string, string>();

    // -------------------------------------------------------------- digest
    const result = buildDigests(reasons, {
      recipients: config.recipients,
      defaultChannels: config.notifications.channels,
      availableChannels: availableChannels(config),
      maxItemsPerDigest: config.notifications.max_items_per_digest,
      timezone: config.schedule.timezone,
      now,
      defaultDomain: config.default_recipient_domain ?? undefined,
      gitlabEmails,
    });

    repo.replaceSnapshot(runId, [
      ...toSnapshotItems(result),
      ...mutedSnapshotItems(muteResult.suppressed),
    ]);
    repo.pruneOldSnapshots(runId);

    if (result.undeliverable.length > 0) {
      const unmapped = result.undeliverable.filter((u) => u.reason === 'no recipient mapping');
      if (unmapped.length > 0) {
        log.warn(
          { users: unmapped.map((u) => u.username) },
          `${unmapped.length} people are blocking merge requests but have no recipient mapping`,
        );
      }
    }

    // ------------------------------------------------------------- deliver
    let sent = 0;
    let failures = 0;

    if (silence.silenced && !options.force) {
      const reason = describeSilence(silence);
      repo.finishRun(runId, {
        status: 'ok',
        mrs_scanned: unique.size,
        reasons_found: reasons.length,
        digests_built: result.digests.length,
        digests_sent: 0,
        skipped_reason: reason,
      });
      audit.record({
        actor: options.trigger === 'schedule' ? 'scheduler' : 'cli',
        action: 'run.held',
        target: String(runId),
        detail: `${result.digests.length} digests withheld: ${reason}`,
      });
      log.info(
        { digests: result.digests.length, reason },
        'scan complete; delivery withheld',
      );
      return {
        runId,
        status: 'skipped',
        skippedReason: reason,
        mrsScanned: unique.size,
        reasonsFound: reasons.length,
        digestsBuilt: result.digests.length,
        digestsSent: 0,
        failures: 0,
        personallyMuted: muteResult.suppressed.length,
        undeliverable: result.undeliverable,
        dryRun,
      };
    }

    const notifiers = options.notifierFactory?.(config, dryRun) ?? buildNotifiers(config, dryRun);
    const subjectTemplate = config.email?.subject_template ?? '{count} merge requests are waiting for you';
    const actor = options.trigger === 'schedule' ? 'scheduler' : 'cli';

    // Self-service links need a reachable address and a stable secret. Without both,
    // digests go out without them rather than carrying links that cannot work.
    const linkBase = selfServiceBaseUrl(config.admin);
    const secret = options.selfServiceSecret ?? '';
    if (!linkBase && secret) {
      log.warn(
        { host: config.admin.host },
        'recipients cannot reach the panel at this address, so digests carry no mute links',
      );
    }

    for (const digest of result.digests) {
      if (config.notifications.skip_empty && digest.items.length === 0) continue;

      const links: SelfServiceLinks | null =
        linkBase && secret
          ? (() => {
              const token = mintRecipientToken(digest.username, secret);
              return {
                mute: (mrUrl: string) => muteLink(linkBase, token, mrUrl),
                manage: manageLink(linkBase, token),
              };
            })()
          : null;

      const rendered = renderDigest(digest, subjectTemplate, links);
      let deliveredAny = false;

      for (const channel of digest.channels) {
        const notifier = notifiers.get(channel);
        if (!notifier) continue;

        try {
          await notifier.send(digest, rendered);
          deliveredAny = true;
          audit.record({
            actor,
            action: 'notification.send',
            target: `${digest.username}/${channel}`,
            after: { items: digest.totalItems, dryRun },
          });
        } catch (err) {
          failures++;
          const message = (err as Error).message;
          log.error({ user: digest.username, channel, err: message }, 'delivery failed');
          audit.record({
            actor,
            action: 'notification.send',
            target: `${digest.username}/${channel}`,
            outcome: 'error',
            detail: message,
          });
        }
      }

      if (deliveredAny) sent++;
    }

    const status = failures > 0 ? 'partial' : 'ok';
    repo.finishRun(runId, {
      status,
      mrs_scanned: unique.size,
      reasons_found: reasons.length,
      digests_built: result.digests.length,
      digests_sent: sent,
      failures,
    });

    log.info(
      {
        scanned: unique.size,
        reasons: reasons.length,
        muted: muteResult.suppressed.length,
        digests: result.digests.length,
        sent,
        failures,
      },
      dryRun ? 'dry run complete' : 'run complete',
    );

    return {
      runId,
      status,
      mrsScanned: unique.size,
      reasonsFound: reasons.length,
      digestsBuilt: result.digests.length,
      digestsSent: sent,
      failures,
      personallyMuted: muteResult.suppressed.length,
      undeliverable: result.undeliverable,
      dryRun,
    };
  } catch (err) {
    const message = (err as Error).message;
    repo.finishRun(runId, { status: 'failed', error: message });
    audit.record({
      actor: options.trigger === 'schedule' ? 'scheduler' : 'cli',
      action: 'run.failed',
      target: String(runId),
      outcome: 'error',
      detail: message,
    });
    log.error({ err: message }, 'run failed');
    throw err;
  } finally {
    repo.prune(config.retention.audit_days, config.retention.run_days);
  }
}
