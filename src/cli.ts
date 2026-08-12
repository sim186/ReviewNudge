#!/usr/bin/env node
import { createApp } from './app.js';
import { startAdminServer } from './admin/server.js';
import { generateSessionSecret } from './admin/auth.js';
import { ConfigError } from './config/load.js';
import { GitLabClient } from './gitlab/client.js';
import { readEnv, readEnvFlag, legacyEnvNames } from './env.js';
import { logger } from './logger.js';
import { buildNotifiers } from './notify/factory.js';
import { renderDigest } from './notify/render.js';
import { Scheduler } from './scheduler.js';
import { executeRun } from './run.js';
import type { Digest } from './domain/digest.js';

type FlagValue = string | true | string[];

interface Args {
  command: string;
  flags: Map<string, FlagValue>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, FlagValue>();

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('-')) continue;
    const name = token.replace(/^-+/, '');
    const next = rest[i + 1];
    if (next && !next.startsWith('-')) {
      const existing = flags.get(name);
      if (typeof existing === 'string') {
        flags.set(name, [existing, next]);
      } else if (Array.isArray(existing)) {
        existing.push(next);
      } else {
        flags.set(name, next);
      }
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

/** The stable secret used for both admin sessions and recipient links. */
function resolveSecret(config: { admin: { session_secret: string } }): string {
  return config.admin.session_secret || readEnv('SESSION_SECRET') || '';
}

function flagString(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags.get(name);
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0) return value[value.length - 1];
  }
  return undefined;
}

function flagBool(args: Args, ...names: string[]): boolean {
  return names.some((name) => args.flags.has(name));
}

function flagStrings(args: Args, ...names: string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    const value = args.flags.get(name);
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) values.push(...value);
  }
  return values;
}

const USAGE = `ReviewNudge — tells people which merge requests are waiting on them.

Usage:
  nudge serve                     Run the scheduler and the admin panel
  nudge run [--once] [--dry-run] [--project <path>]
                                  Run one cycle now (--once is the default).
                                  --project can be repeated to limit the scan.
  nudge check-config [--remote]   Validate the config file; --remote also tests GitLab
  nudge test-notify --recipient U Send one sample digest to a recipient
  nudge help

Options:
  -c, --config <path>   Config file (default: config/config.yaml, or $NUDGE_CONFIG)
      --dry-run         Render digests to stdout instead of delivering them
      --remote          Contact GitLab as part of check-config
      --project <path>  Full project path to include (repeatable); e.g. group/project
      --recipient <u>   GitLab username to send the sample to

Environment:
  NUDGE_CONFIG, NUDGE_DATA_DIR, NUDGE_DRY_RUN, NUDGE_SILENCE, NUDGE_ADMIN_HOST,
  NUDGE_ADMIN_PASSWORD, NUDGE_SESSION_SECRET, LOG_LEVEL, LOG_FORMAT

  The former MRA_* names still work; NUDGE_* wins where both are set.
`;

async function commandCheckConfig(args: Args): Promise<number> {
  const app = createApp(flagString(args, 'c', 'config'));
  const config = app.provider.resolve();

  logger.info(
    {
      groups: config.gitlab.groups,
      channels: config.notifications.channels,
      recipients: config.recipients.length,
      schedule: `${config.schedule.cron} (${config.schedule.timezone})`,
    },
    'configuration is valid',
  );

  if (config.notifications.channels.length === 0) {
    logger.warn('no notification channels are enabled; nothing would ever be delivered');
  }
  if (config.recipients.length === 0) {
    logger.warn('no recipients are configured; every digest would be undeliverable');
  }

  let exitCode = 0;
  if (flagBool(args, 'remote')) {
    try {
      const client = new GitLabClient({
        url: config.gitlab.url,
        token: config.gitlab.token,
        timeoutMs: config.gitlab.timeout_ms,
        logger,
      });
      const info = await client.checkConnection();
      logger.info({ user: info.username, version: info.version }, 'connected to GitLab');

      for (const group of config.gitlab.groups) {
        const mrs = await client.fetchGroupMergeRequests(group, config.gitlab.include_subgroups);
        logger.info({ group, openMergeRequests: mrs.length }, 'group readable');
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'GitLab check failed');
      exitCode = 1;
    }
  }

  app.close();
  return exitCode;
}

async function commandRun(args: Args): Promise<number> {
  const app = createApp(flagString(args, 'c', 'config'));
  const dryRun = flagBool(args, 'dry-run') || readEnvFlag('DRY_RUN');
  const projectFilter = flagStrings(args, 'project');

  try {
    const summary = await executeRun(app.provider, app.repo, app.audit, {
      trigger: 'cli',
      dryRun,
      logger,
      selfServiceSecret: resolveSecret(app.provider.resolve()),
      projectFilter: projectFilter.length > 0 ? projectFilter : undefined,
    });

    for (const group of summary.undeliverable) {
      logger.warn(
        { user: group.username, items: group.itemCount, reason: group.reason },
        'digest not delivered',
      );
    }

    // Everything failing is an operational problem worth a non-zero exit for cron.
    return summary.digestsBuilt > 0 && summary.digestsSent === 0 && summary.failures > 0 ? 1 : 0;
  } catch {
    return 1;
  } finally {
    app.close();
  }
}

async function commandTestNotify(args: Args): Promise<number> {
  const username = flagString(args, 'recipient', 'r');
  if (!username) {
    logger.error('give a recipient, for example: nudge test-notify --recipient alice');
    return 1;
  }

  const app = createApp(flagString(args, 'c', 'config'));
  const config = app.provider.resolve();
  let recipient = config.recipients.find((r) => r.gitlab_username === username);

  if (!recipient && config.default_recipient_domain) {
    const derivedAddress = `${username}@${config.default_recipient_domain}`;
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
    logger.error({ username }, 'no such recipient; add them in the admin panel or config.yaml');
    app.close();
    return 1;
  }

  const now = new Date();
  const sample: Digest = {
    username,
    recipient,
    channels: config.notifications.channels,
    items: [
      {
        mr: {
          url: `${config.gitlab.url}/example/project/-/merge_requests/1`,
          title: 'Sample merge request from ReviewNudge',
          projectPath: 'example/project',
          iid: '1',
          author: 'someone-else',
          createdAt: new Date(now.getTime() - 4 * 86_400_000).toISOString(),
          updatedAt: now.toISOString(),
          lastPushAt: now.toISOString(),
          labels: [],
          notesCount: 0,
        },
        kinds: ['REVIEW_REQUESTED'],
        waitingSince: new Date(now.getTime() - 4 * 86_400_000).toISOString(),
        waitingDays: 4,
        detail: 'This is a test message. If you can read it, delivery works.',
      },
    ],
    totalItems: 1,
    truncated: 0,
  };

  const rendered = renderDigest(sample, config.email?.subject_template ?? '{count} waiting');
  const notifiers = buildNotifiers(config, false);
  let failures = 0;

  for (const channel of config.notifications.channels) {
    const notifier = notifiers.get(channel);
    if (!notifier) {
      logger.warn({ channel }, 'channel is enabled but not configured; skipping');
      continue;
    }
    try {
      if (notifier.verify) await notifier.verify();
      await notifier.send(sample, rendered);
      logger.info({ channel, username }, 'sample delivered');
      app.audit.record({ actor: 'cli', action: 'notification.test', target: `${username}/${channel}` });
    } catch (err) {
      failures++;
      const message = (err as Error).message;
      logger.error({ channel, err: message }, 'sample delivery failed');
      app.audit.record({
        actor: 'cli',
        action: 'notification.test',
        target: `${username}/${channel}`,
        outcome: 'error',
        detail: message,
      });
    }
  }

  app.close();
  return failures > 0 ? 1 : 0;
}

async function commandServe(args: Args): Promise<number> {
  const app = createApp(flagString(args, 'c', 'config'));
  const config = app.provider.resolve();
  const dryRun = flagBool(args, 'dry-run') || readEnvFlag('DRY_RUN');

  const sessionSecret = resolveSecret(config);
  if (!sessionSecret) {
    logger.warn(
      'no admin session secret set: sessions will not survive a restart, and digests will carry no self-service mute links',
    );
  }

  const scheduler = new Scheduler(app.provider, app.repo, app.audit, {
    dryRun,
    logger,
    selfServiceSecret: sessionSecret,
  });
  scheduler.start();

  let server: Awaited<ReturnType<typeof startAdminServer>> | null = null;
  if (config.admin.enabled) {
    server = await startAdminServer(
      { provider: app.provider, repo: app.repo, audit: app.audit, scheduler, logger },
      {
        host: config.admin.host,
        port: config.admin.port,
        password: config.admin.password,
        sessionSecret: sessionSecret || generateSessionSecret(),
        sessionTtlHours: config.admin.session_ttl_hours,
      },
    );
  } else {
    logger.info('admin panel is disabled');
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    if (server) await server.close();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Resolves only on shutdown.
  return new Promise<number>(() => {});
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const legacy = legacyEnvNames();
  if (legacy.length > 0) {
    logger.warn(
      { variables: legacy },
      'these environment variables use the old MRA_ prefix; they still work, but NUDGE_ is the current name',
    );
  }

  try {
    switch (args.command) {
      case 'serve':
        process.exitCode = await commandServe(args);
        break;
      case 'run':
        process.exitCode = await commandRun(args);
        break;
      case 'check-config':
        process.exitCode = await commandCheckConfig(args);
        break;
      case 'test-notify':
        process.exitCode = await commandTestNotify(args);
        break;
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        break;
      default:
        process.stderr.write(`Unknown command "${args.command}".\n\n${USAGE}`);
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      // Config problems are the operator's to fix; a stack trace only gets in the way.
      process.stderr.write(`${err.message}\n`);
    } else {
      logger.error({ err: (err as Error).message }, 'command failed');
    }
    process.exitCode = 1;
  }
}

void main();
