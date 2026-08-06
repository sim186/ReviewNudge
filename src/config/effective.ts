import { z } from 'zod';
import type { Repo, ExclusionKind, RecipientRow } from '../db/repo.js';
import {
  channelSchema,
  excludeSchema,
  rulesSchema,
  silenceSchema,
  weekdaySchema,
  type Channel,
  type Config,
  type Exclusions,
  type NotificationSettings,
  type QuietHours,
  type Rules,
  type Weekday,
} from './schema.js';

/**
 * The merged view of configuration that the rest of the application reads.
 *
 * config.yaml supplies infrastructure, secrets, and defaults. The database supplies
 * operator overrides made through the admin panel. Database wins, per key.
 */
export interface EffectiveConfig {
  gitlab: Config['gitlab'];
  admin: Config['admin'];
  email: Config['email'];
  teams: Config['teams'];
  slack: Config['slack'];
  telegram: Config['telegram'];
  retention: Config['retention'];
  schedule: Config['schedule'];
  rules: Rules;
  exclude: Exclusions;
  silence: {
    enabled: boolean;
    quiet_hours: QuietHours | null;
    working_days: Weekday[];
    holidays: string[];
    muted_merge_requests: string[];
  };
  notifications: NotificationSettings;
  recipients: RecipientRow[];
}

/**
 * Scalar settings the panel may override, each with the schema used to validate a
 * stored value. A key missing from the database means "use the file default".
 */
export const SETTING_SCHEMAS = {
  'schedule.cron': z.string().min(1),
  'schedule.timezone': z.string().min(1),
  'rules.reviewer_not_approved': z.boolean(),
  'rules.assignee_action_pending': z.boolean(),
  'rules.unresolved_threads': z.boolean(),
  'rules.require_activity_since_push': z.boolean(),
  'rules.min_age_hours': z.number().min(0),
  'rules.ignore_draft': z.boolean(),
  'exclude.bots': z.boolean(),
  'silence.enabled': z.boolean(),
  'silence.quiet_hours': silenceSchema.shape.quiet_hours,
  'silence.working_days': z.array(weekdaySchema),
  'silence.holidays': z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  'notifications.channels': z.array(channelSchema),
  'notifications.max_items_per_digest': z.number().int().positive(),
  'notifications.skip_empty': z.boolean(),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTING_SCHEMAS, key);
}

/** Maps an exclusion kind to the config.yaml array it extends. */
const EXCLUSION_FILE_KEY: Record<Exclude<ExclusionKind, 'muted_mr'>, keyof Exclusions> = {
  project: 'projects',
  user: 'users',
  mr_label: 'mr_labels',
};

export interface ExclusionEntry {
  /** Database id, or null for an entry that came from config.yaml. */
  id: number | null;
  kind: ExclusionKind;
  pattern: string;
  origin: 'file' | 'panel';
  note: string | null;
  created_by: string | null;
  created_at: string | null;
}

export class ConfigProvider {
  constructor(
    private readonly file: Config,
    private readonly repo: Repo,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** The config.yaml values, for the panel's "reset to file default" affordance. */
  get fileConfig(): Config {
    return this.file;
  }

  /**
   * Reads one override. A stored value that no longer validates (schema changed, or
   * hand-edited database) is ignored in favour of the file default rather than
   * crashing a scheduled run.
   */
  private override<K extends SettingKey>(
    key: K,
    fallback: z.infer<(typeof SETTING_SCHEMAS)[K]>,
  ): z.infer<(typeof SETTING_SCHEMAS)[K]> {
    const stored = this.repo.getSetting<unknown>(key);
    if (stored === undefined) return fallback;
    const parsed = SETTING_SCHEMAS[key].safeParse(stored);
    return parsed.success ? (parsed.data as z.infer<(typeof SETTING_SCHEMAS)[K]>) : fallback;
  }

  /** True when the key currently has a database override. */
  hasOverride(key: SettingKey): boolean {
    return this.repo.getSetting(key) !== undefined;
  }

  /**
   * Every exclusion of one kind, tagged with where it came from. File entries have
   * no id and can only be shadowed, not deleted, through the panel.
   */
  exclusionEntries(kind: ExclusionKind): ExclusionEntry[] {
    const fromFile =
      kind === 'muted_mr'
        ? this.file.silence.muted_merge_requests
        : this.file.exclude[EXCLUSION_FILE_KEY[kind]];

    const entries: ExclusionEntry[] = (fromFile as string[]).map((pattern) => ({
      id: null,
      kind,
      pattern,
      origin: 'file' as const,
      note: null,
      created_by: null,
      created_at: null,
    }));

    const seen = new Set(entries.map((e) => e.pattern));
    for (const row of this.repo.listExclusions(kind)) {
      if (seen.has(row.pattern)) continue;
      entries.push({
        id: row.id,
        kind,
        pattern: row.pattern,
        origin: 'panel',
        note: row.note,
        created_by: row.created_by,
        created_at: row.created_at,
      });
    }
    return entries;
  }

  private mergedExclusions(kind: ExclusionKind): string[] {
    return this.exclusionEntries(kind).map((e) => e.pattern);
  }

  /** Recipients, database-first, falling back to the file list before seeding. */
  recipients(): RecipientRow[] {
    const rows = this.repo.listRecipients();
    if (rows.length > 0) return rows;
    return this.file.recipients.map((r) => ({
      gitlab_username: r.gitlab_username,
      email: r.email,
      teams_upn: r.teams_upn,
      slack_id: r.slack_id,
      telegram_chat_id: r.telegram_chat_id,
      channels: r.channels,
      snooze_until: r.snooze_until,
      enabled: true,
    }));
  }

  resolve(): EffectiveConfig {
    const f = this.file;

    // MRA_SILENCE is an escape hatch for operators without panel access — it can
    // force silence on, but never off, so it cannot quietly defeat the toggle.
    const envSilence = this.env.MRA_SILENCE === '1' || this.env.MRA_SILENCE === 'true';

    return {
      gitlab: f.gitlab,
      admin: f.admin,
      email: f.email,
      teams: f.teams,
      slack: f.slack,
      telegram: f.telegram,
      retention: f.retention,
      schedule: {
        cron: this.override('schedule.cron', f.schedule.cron),
        timezone: this.override('schedule.timezone', f.schedule.timezone),
        run_on_start: f.schedule.run_on_start,
      },
      rules: rulesSchema.parse({
        reviewer_not_approved: this.override(
          'rules.reviewer_not_approved',
          f.rules.reviewer_not_approved,
        ),
        assignee_action_pending: this.override(
          'rules.assignee_action_pending',
          f.rules.assignee_action_pending,
        ),
        unresolved_threads: this.override('rules.unresolved_threads', f.rules.unresolved_threads),
        require_activity_since_push: this.override(
          'rules.require_activity_since_push',
          f.rules.require_activity_since_push,
        ),
        min_age_hours: this.override('rules.min_age_hours', f.rules.min_age_hours),
        ignore_draft: this.override('rules.ignore_draft', f.rules.ignore_draft),
      }),
      exclude: excludeSchema.parse({
        projects: this.mergedExclusions('project'),
        mr_labels: this.mergedExclusions('mr_label'),
        users: this.mergedExclusions('user'),
        bots: this.override('exclude.bots', f.exclude.bots),
      }),
      silence: {
        enabled: envSilence || this.override('silence.enabled', f.silence.enabled),
        quiet_hours: this.override('silence.quiet_hours', f.silence.quiet_hours),
        working_days: this.override('silence.working_days', f.silence.working_days),
        holidays: this.override('silence.holidays', f.silence.holidays),
        muted_merge_requests: this.mergedExclusions('muted_mr'),
      },
      notifications: {
        channels: this.override(
          'notifications.channels',
          f.notifications.channels,
        ) as Channel[],
        max_items_per_digest: this.override(
          'notifications.max_items_per_digest',
          f.notifications.max_items_per_digest,
        ),
        skip_empty: this.override('notifications.skip_empty', f.notifications.skip_empty),
      },
      recipients: this.recipients(),
    };
  }
}
