import type { ConfigProvider, EffectiveConfig } from './config/effective.js';
import type { Channel } from './config/schema.js';
import type { Audit } from './db/audit.js';
import type { Repo, RunTrigger, SnapshotItem } from './db/repo.js';
import { buildDigests, type Digest, type DigestResult } from './domain/digest.js';
import { filterMergeRequest } from './domain/filters.js';
import { evaluateMergeRequest, type Reason } from './domain/reasons.js';
import { describeSilence, evaluateRunSilence } from './domain/silence.js';
import { GitLabClient } from './gitlab/client.js';
import type { EnrichedMergeRequest, GqlMergeRequest } from './gitlab/types.js';
import { logger as rootLogger, type Logger } from './logger.js';
import { ConsoleNotifier } from './notify/console.js';
import { EmailNotifier } from './notify/email.js';
import { renderDigest } from './notify/render.js';
import { TeamsNotifier } from './notify/teams.js';
import type { Notifier } from './notify/types.js';

export interface RunOptions {
  trigger: RunTrigger;
  dryRun?: boolean;
  /** Ignore silencing and deliver anyway. Used by `test-notify`, never by the scheduler. */
  force?: boolean;
  now?: Date;
  logger?: Logger;
  clientFactory?: (config: EffectiveConfig) => GitLabClient;
  notifierFactory?: (config: EffectiveConfig, dryRun: boolean) => Map<Channel, Notifier>;
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
  undeliverable: DigestResult['undeliverable'];
  dryRun: boolean;
}

export function buildNotifiers(config: EffectiveConfig, dryRun: boolean): Map<Channel, Notifier> {
  const notifiers = new Map<Channel, Notifier>();
  for (const channel of config.notifications.channels) {
    if (dryRun) {
      notifiers.set(channel, new ConsoleNotifier(channel));
      continue;
    }
    if (channel === 'email' && config.email) notifiers.set(channel, new EmailNotifier(config.email));
    if (channel === 'teams' && config.teams) notifiers.set(channel, new TeamsNotifier(config.teams));
  }
  return notifiers;
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
      logger: log,
    });

  try {
    // ---------------------------------------------------------------- scan
    const raw: GqlMergeRequest[] = [];
    for (const group of config.gitlab.groups) {
      raw.push(...(await client.fetchGroupMergeRequests(group, config.gitlab.include_subgroups)));
    }

    // A merge request visible through two groups must not be counted twice.
    const unique = new Map(raw.map((mr) => [mr.id, mr]));

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
    const reasons: Reason[] = enriched.flatMap((mr) =>
      evaluateMergeRequest(mr, { rules: config.rules, userFilter }),
    );

    // -------------------------------------------------------------- digest
    const availableChannels = [...config.notifications.channels].filter(
      (c) => (c === 'email' && config.email) || (c === 'teams' && config.teams),
    );
    const result = buildDigests(reasons, {
      recipients: config.recipients,
      defaultChannels: config.notifications.channels,
      availableChannels,
      maxItemsPerDigest: config.notifications.max_items_per_digest,
      timezone: config.schedule.timezone,
      now,
    });

    repo.replaceSnapshot(runId, toSnapshotItems(result));
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
        undeliverable: result.undeliverable,
        dryRun,
      };
    }

    const notifiers = options.notifierFactory?.(config, dryRun) ?? buildNotifiers(config, dryRun);
    const subjectTemplate = config.email?.subject_template ?? '{count} merge requests are waiting for you';
    const actor = options.trigger === 'schedule' ? 'scheduler' : 'cli';

    for (const digest of result.digests) {
      if (config.notifications.skip_empty && digest.items.length === 0) continue;
      const rendered = renderDigest(digest, subjectTemplate);
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
      { scanned: unique.size, reasons: reasons.length, digests: result.digests.length, sent, failures },
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
