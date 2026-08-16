import { z } from 'zod';

/**
 * Schema for config.yaml. This file holds infrastructure and secrets and is never
 * written by the application — operational settings (exclusions, snoozes, the pause
 * switch) are stored in SQLite and layered on top by config/effective.ts.
 */

export const CHANNELS = ['email', 'teams', 'slack', 'telegram'] as const;
export const channelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof channelSchema>;

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const weekdaySchema = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof weekdaySchema>;

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a 24-hour time such as "18:00"');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date such as "2026-12-25"');

const gitlabSchema = z.object({
  url: z.string().url().describe('Base URL of the GitLab instance, without /api/v4'),
  token: z.string().min(1).describe('Personal access token with read_api scope'),
  groups: z
    .array(z.string().min(1))
    .min(1)
    .describe('Full paths of groups to scan, e.g. "engineering" or "platform/infra"'),
  /** If non-empty, only these project full paths are scanned (whitelist). */
  projects: z.array(z.string().min(1)).default([]),
  include_subgroups: z.boolean().default(true),
  timeout_ms: z.number().int().positive().default(30_000),
  page_size: z.number().int().min(1).max(100).default(50),
  max_retries: z.number().int().min(0).max(10).default(4),
});

const adminSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65_535).default(8080),
  /** Public URL recipients can use; separate from the bind address for reverse proxies. */
  public_url: z.string().url().optional(),
  password: z.string().default(''),
  session_secret: z.string().default(''),
  session_ttl_hours: z.number().int().positive().default(12),
});

const scheduleSchema = z.object({
  cron: z.string().min(1).default('0 9 * * 1-5'),
  timezone: z.string().min(1).default('UTC'),
  run_on_start: z.boolean().default(false),
});

export const rulesSchema = z.object({
  reviewer_not_approved: z.boolean().default(true),
  assignee_action_pending: z.boolean().default(true),
  unresolved_threads: z.boolean().default(true),
  require_activity_since_push: z.boolean().default(true),
  min_age_hours: z.number().min(0).default(12),
  ignore_draft: z.boolean().default(true),

  /** Warn when a non-draft merge request has no reviewer anyone could be waiting on. */
  warn_missing_reviewer: z.boolean().default(true),
  /**
   * Warn when neither the title nor the description mentions an issue key. Off by
   * default: plenty of teams have no tracker to reference.
   */
  warn_missing_ticket: z.boolean().default(false),
  /** Matched case-insensitively against the title and the description. */
  ticket_pattern: z.string().min(1).default('[A-Z][A-Z0-9]+-\\d+'),
  /**
   * When a merge request produces no reasons for anyone, send its warnings to the
   * author. Without this an unattended merge request appears in nobody's digest.
   */
  notify_author_of_warnings: z.boolean().default(true),
});

export const excludeSchema = z.object({
  projects: z.array(z.string()).default([]),
  mr_labels: z.array(z.string()).default([]),
  users: z.array(z.string()).default([]),
  bots: z.boolean().default(true),
});

const quietHoursSchema = z.object({
  start: timeOfDay,
  end: timeOfDay,
});

export const silenceSchema = z.object({
  enabled: z.boolean().default(false),
  quiet_hours: quietHoursSchema.nullable().default(null),
  working_days: z.array(weekdaySchema).default(['mon', 'tue', 'wed', 'thu', 'fri']),
  holidays: z.array(isoDate).default([]),
  muted_merge_requests: z.array(z.string()).default([]),
});

export const notificationsSchema = z.object({
  channels: z.array(channelSchema).default(['email']),
  max_items_per_digest: z.number().int().positive().default(25),
  skip_empty: z.boolean().default(true),
});

const smtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535).default(587),
  secure: z.boolean().default(false),
  user: z.string().optional(),
  pass: z.string().optional(),
  reject_unauthorized: z.boolean().default(true),
});

const emailSchema = z.object({
  smtp: smtpSchema,
  from: z.string().min(1),
  subject_template: z.string().default('{count} merge requests are waiting for you'),
});

const teamsSchema = z.object({
  workflow_url: z.string().url(),
  timeout_ms: z.number().int().positive().default(15_000),
});

const slackSchema = z.object({
  /** Bot token (xoxb-…) with the chat:write scope. Required for direct messages. */
  bot_token: z.string().min(1),
  api_url: z.string().url().default('https://slack.com/api'),
  timeout_ms: z.number().int().positive().default(15_000),
});

const telegramSchema = z.object({
  /** Token from @BotFather. */
  bot_token: z.string().min(1),
  api_url: z.string().url().default('https://api.telegram.org'),
  timeout_ms: z.number().int().positive().default(15_000),
  /** Telegram notifies loudly by default; silence the ping but still deliver. */
  disable_notification: z.boolean().default(false),
});

export const recipientSchema = z.object({
  gitlab_username: z.string().min(1),
  email: z.string().email().nullable().default(null),
  teams_upn: z.string().nullable().default(null),
  /** Slack member ID (U…), which is what chat.postMessage opens a direct message to. */
  slack_id: z.string().nullable().default(null),
  /** Telegram chat ID. The person must message the bot once before this exists. */
  telegram_chat_id: z.string().nullable().default(null),
  channels: z.array(channelSchema).nullable().default(null),
  snooze_until: isoDate.nullable().default(null),
});
export type RecipientConfig = z.infer<typeof recipientSchema>;

/**
 * Whether a string compiles as a regular expression. Used to reject a bad
 * `ticket_pattern` at load time rather than silently matching nothing on every run.
 */
export function isValidPattern(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const domainSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
    'must be a domain such as "example.com"',
  );

export const configSchema = z
  .object({
    gitlab: gitlabSchema,
    admin: adminSchema.default({}),
    schedule: scheduleSchema.default({}),
    rules: rulesSchema.default({}),
    exclude: excludeSchema.default({}),
    silence: silenceSchema.default({}),
    notifications: notificationsSchema.default({}),
    email: emailSchema.optional(),
    teams: teamsSchema.optional(),
    slack: slackSchema.optional(),
    telegram: telegramSchema.optional(),
    recipients: z.array(recipientSchema).default([]),
    /** When a GitLab username has no explicit recipient entry, derive the email as `{username}@{domain}`. */
    default_recipient_domain: domainSchema.optional(),
    retention: z
      .object({
        audit_days: z.number().int().positive().default(180),
        run_days: z.number().int().positive().default(90),
      })
      .default({}),
  })
  .superRefine((cfg, ctx) => {
    // A channel that is switched on but not configured would fail silently at send
    // time, long after the operator has stopped watching. Catch it at load.
    for (const channel of CHANNELS) {
      if (cfg.notifications.channels.includes(channel) && !cfg[channel]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [channel],
          message: `notifications.channels includes "${channel}" but the ${channel} section is missing`,
        });
      }
    }
    if (!isValidPattern(cfg.rules.ticket_pattern)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rules', 'ticket_pattern'],
        message: `"${cfg.rules.ticket_pattern}" is not a valid regular expression`,
      });
    }
    if (cfg.admin.enabled && cfg.admin.password.length < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['admin', 'password'],
        message:
          'admin.password must be at least 8 characters (set NUDGE_ADMIN_PASSWORD), or set admin.enabled to false',
      });
    }

    const seen = new Set<string>();
    cfg.recipients.forEach((r, i) => {
      if (seen.has(r.gitlab_username)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recipients', i, 'gitlab_username'],
          message: `duplicate recipient "${r.gitlab_username}"`,
        });
      }
      seen.add(r.gitlab_username);
    });
  });

export type Config = z.infer<typeof configSchema>;
export type Rules = z.infer<typeof rulesSchema>;
export type Exclusions = z.infer<typeof excludeSchema>;
export type SilenceSettings = z.infer<typeof silenceSchema>;
export type NotificationSettings = z.infer<typeof notificationsSchema>;
export type QuietHours = z.infer<typeof quietHoursSchema>;
