import type { Db } from './migrate.js';
import type { Channel, RecipientConfig } from '../config/schema.js';

export type ExclusionKind = 'project' | 'user' | 'mr_label' | 'muted_mr';

export interface ExclusionRow {
  id: number;
  kind: ExclusionKind;
  pattern: string;
  note: string | null;
  created_at: string;
  created_by: string;
}

export interface RecipientRow {
  gitlab_username: string;
  email: string | null;
  teams_upn: string | null;
  slack_id: string | null;
  telegram_chat_id: string | null;
  channels: Channel[] | null;
  snooze_until: string | null;
  enabled: boolean;
}

export type MuteMode = 'until_change' | 'until' | 'forever';

/** Fingerprint of a merge request at mute time, for `until_change` mutes. */
export interface MuteBaseline {
  lastPushAt: string | null;
  notesCount: number | null;
}

export interface UserMuteRow {
  id: number;
  gitlab_username: string;
  mr_url: string;
  mr_title: string | null;
  mode: MuteMode;
  until: string | null;
  baseline: MuteBaseline | null;
  created_at: string;
  created_by: string;
}

interface RawUserMute extends Omit<UserMuteRow, 'baseline'> {
  baseline: string | null;
}

function toUserMute(row: RawUserMute): UserMuteRow {
  return {
    ...row,
    baseline: row.baseline ? (JSON.parse(row.baseline) as MuteBaseline) : null,
  };
}

export type RunStatus = 'running' | 'ok' | 'partial' | 'failed' | 'skipped';
export type RunTrigger = 'schedule' | 'manual' | 'cli';

export interface RunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  trigger: RunTrigger;
  dry_run: boolean;
  mrs_scanned: number;
  reasons_found: number;
  digests_built: number;
  digests_sent: number;
  failures: number;
  skipped_reason: string | null;
  error: string | null;
}

export interface SnapshotItem {
  gitlab_username: string;
  mr_url: string;
  mr_title: string;
  project_path: string;
  author: string | null;
  reasons: string[];
  waiting_since: string;
  deliverable: boolean;
  skip_reason: string | null;
}

interface RawRecipient {
  gitlab_username: string;
  email: string | null;
  teams_upn: string | null;
  slack_id: string | null;
  telegram_chat_id: string | null;
  channels: string | null;
  snooze_until: string | null;
  enabled: number;
}

interface RawRun extends Omit<RunRow, 'dry_run'> {
  dry_run: number;
}

interface RawSnapshotItem extends Omit<SnapshotItem, 'reasons' | 'deliverable'> {
  reasons: string;
  deliverable: number;
}

function toRecipient(row: RawRecipient): RecipientRow {
  return {
    gitlab_username: row.gitlab_username,
    email: row.email,
    teams_upn: row.teams_upn,
    slack_id: row.slack_id,
    telegram_chat_id: row.telegram_chat_id,
    channels: row.channels ? (JSON.parse(row.channels) as Channel[]) : null,
    snooze_until: row.snooze_until,
    enabled: row.enabled === 1,
  };
}

function toRun(row: RawRun): RunRow {
  return { ...row, dry_run: row.dry_run === 1 };
}

/**
 * Typed access to every table. Deliberately the only place that writes SQL, so the
 * shape of what the panel and the run cycle can change stays reviewable in one file.
 */
export class Repo {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- settings

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value));
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  allSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  }

  // -------------------------------------------------------------- exclusions

  listExclusions(kind?: ExclusionKind): ExclusionRow[] {
    const sql = kind
      ? 'SELECT * FROM exclusions WHERE kind = ? ORDER BY pattern'
      : 'SELECT * FROM exclusions ORDER BY kind, pattern';
    const stmt = this.db.prepare(sql);
    return (kind ? stmt.all(kind) : stmt.all()) as ExclusionRow[];
  }

  /** Returns the new row, or null when the pattern already exists for that kind. */
  addExclusion(
    kind: ExclusionKind,
    pattern: string,
    note: string | null,
    createdBy: string,
  ): ExclusionRow | null {
    const result = this.db
      .prepare(
        `INSERT INTO exclusions (kind, pattern, note, created_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, pattern) DO NOTHING`,
      )
      .run(kind, pattern, note, createdBy);
    if (result.changes === 0) return null;
    return this.db
      .prepare('SELECT * FROM exclusions WHERE id = ?')
      .get(result.lastInsertRowid) as ExclusionRow;
  }

  /** Returns the removed row, or null when the id did not exist. */
  removeExclusion(id: number): ExclusionRow | null {
    const row = this.db.prepare('SELECT * FROM exclusions WHERE id = ?').get(id) as
      | ExclusionRow
      | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM exclusions WHERE id = ?').run(id);
    return row;
  }

  // -------------------------------------------------------------- recipients

  listRecipients(): RecipientRow[] {
    const rows = this.db
      .prepare('SELECT * FROM recipients ORDER BY gitlab_username')
      .all() as RawRecipient[];
    return rows.map(toRecipient);
  }

  getRecipient(username: string): RecipientRow | null {
    const row = this.db.prepare('SELECT * FROM recipients WHERE gitlab_username = ?').get(username) as
      | RawRecipient
      | undefined;
    return row ? toRecipient(row) : null;
  }

  upsertRecipient(r: Omit<RecipientRow, 'enabled'> & { enabled?: boolean }): RecipientRow {
    this.db
      .prepare(
        `INSERT INTO recipients
           (gitlab_username, email, teams_upn, slack_id, telegram_chat_id, channels, snooze_until, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (gitlab_username) DO UPDATE SET
           email = excluded.email,
           teams_upn = excluded.teams_upn,
           slack_id = excluded.slack_id,
           telegram_chat_id = excluded.telegram_chat_id,
           channels = excluded.channels,
           snooze_until = excluded.snooze_until,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        r.gitlab_username,
        r.email,
        r.teams_upn,
        r.slack_id,
        r.telegram_chat_id,
        r.channels ? JSON.stringify(r.channels) : null,
        r.snooze_until,
        r.enabled === false ? 0 : 1,
      );
    return this.getRecipient(r.gitlab_username)!;
  }

  deleteRecipient(username: string): RecipientRow | null {
    const existing = this.getRecipient(username);
    if (!existing) return null;
    this.db.prepare('DELETE FROM recipients WHERE gitlab_username = ?').run(username);
    return existing;
  }

  /**
   * Copies recipients from config.yaml into the database on first start only.
   * Existing rows are left alone so the file never clobbers panel edits.
   */
  seedRecipients(recipients: RecipientConfig[]): number {
    const insert = this.db.prepare(
      `INSERT INTO recipients
         (gitlab_username, email, teams_upn, slack_id, telegram_chat_id, channels, snooze_until)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (gitlab_username) DO NOTHING`,
    );
    const run = this.db.transaction((rows: RecipientConfig[]) => {
      let inserted = 0;
      for (const r of rows) {
        const res = insert.run(
          r.gitlab_username,
          r.email,
          r.teams_upn,
          r.slack_id,
          r.telegram_chat_id,
          r.channels ? JSON.stringify(r.channels) : null,
          r.snooze_until,
        );
        inserted += res.changes;
      }
      return inserted;
    });
    return run(recipients);
  }

  // -------------------------------------------------------------- user mutes

  /** Every mute a person currently has, newest first. */
  listUserMutes(username: string): UserMuteRow[] {
    const rows = this.db
      .prepare('SELECT * FROM user_mutes WHERE gitlab_username = ? ORDER BY created_at DESC')
      .all(username) as RawUserMute[];
    return rows.map(toUserMute);
  }

  /** All mutes, for the run cycle to apply in one pass. */
  allUserMutes(): UserMuteRow[] {
    const rows = this.db.prepare('SELECT * FROM user_mutes').all() as RawUserMute[];
    return rows.map(toUserMute);
  }

  getUserMute(username: string, mrUrl: string): UserMuteRow | null {
    const row = this.db
      .prepare('SELECT * FROM user_mutes WHERE gitlab_username = ? AND mr_url = ?')
      .get(username, mrUrl) as RawUserMute | undefined;
    return row ? toUserMute(row) : null;
  }

  /** Creates or replaces a person's mute for one merge request. */
  upsertUserMute(mute: {
    gitlab_username: string;
    mr_url: string;
    mr_title: string | null;
    mode: MuteMode;
    until: string | null;
    baseline: MuteBaseline | null;
    created_by?: string;
  }): UserMuteRow {
    this.db
      .prepare(
        `INSERT INTO user_mutes (gitlab_username, mr_url, mr_title, mode, until, baseline, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (gitlab_username, mr_url) DO UPDATE SET
           mr_title = excluded.mr_title,
           mode = excluded.mode,
           until = excluded.until,
           baseline = excluded.baseline,
           created_by = excluded.created_by,
           created_at = excluded.created_at`,
      )
      .run(
        mute.gitlab_username,
        mute.mr_url,
        mute.mr_title,
        mute.mode,
        mute.until,
        mute.baseline ? JSON.stringify(mute.baseline) : null,
        mute.created_by ?? 'recipient',
      );
    return this.getUserMute(mute.gitlab_username, mute.mr_url)!;
  }

  /** Returns the removed mute, or null when there was nothing to remove. */
  removeUserMute(username: string, mrUrl: string): UserMuteRow | null {
    const existing = this.getUserMute(username, mrUrl);
    if (!existing) return null;
    this.db
      .prepare('DELETE FROM user_mutes WHERE gitlab_username = ? AND mr_url = ?')
      .run(username, mrUrl);
    return existing;
  }

  /** Drops mutes that can no longer suppress anything, keeping the table tidy. */
  deleteExpiredUserMutes(expired: { gitlab_username: string; mr_url: string }[]): number {
    const stmt = this.db.prepare(
      'DELETE FROM user_mutes WHERE gitlab_username = ? AND mr_url = ?',
    );
    const run = this.db.transaction((rows: typeof expired) => {
      let removed = 0;
      for (const row of rows) removed += stmt.run(row.gitlab_username, row.mr_url).changes;
      return removed;
    });
    return run(expired);
  }

  // -------------------------------------------------------------------- runs

  startRun(trigger: RunTrigger, dryRun: boolean): number {
    const res = this.db
      .prepare(
        `INSERT INTO runs (started_at, status, trigger, dry_run)
         VALUES (datetime('now'), 'running', ?, ?)`,
      )
      .run(trigger, dryRun ? 1 : 0);
    return Number(res.lastInsertRowid);
  }

  finishRun(
    id: number,
    stats: Partial<
      Pick<
        RunRow,
        | 'status'
        | 'mrs_scanned'
        | 'reasons_found'
        | 'digests_built'
        | 'digests_sent'
        | 'failures'
        | 'skipped_reason'
        | 'error'
      >
    >,
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET
           finished_at = datetime('now'),
           status = COALESCE(?, status),
           mrs_scanned = COALESCE(?, mrs_scanned),
           reasons_found = COALESCE(?, reasons_found),
           digests_built = COALESCE(?, digests_built),
           digests_sent = COALESCE(?, digests_sent),
           failures = COALESCE(?, failures),
           skipped_reason = COALESCE(?, skipped_reason),
           error = COALESCE(?, error)
         WHERE id = ?`,
      )
      .run(
        stats.status ?? null,
        stats.mrs_scanned ?? null,
        stats.reasons_found ?? null,
        stats.digests_built ?? null,
        stats.digests_sent ?? null,
        stats.failures ?? null,
        stats.skipped_reason ?? null,
        stats.error ?? null,
        id,
      );
  }

  latestRun(): RunRow | null {
    const row = this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() as
      | RawRun
      | undefined;
    return row ? toRun(row) : null;
  }

  /** Most recent completed run that actually produced a snapshot. */
  latestCompletedRun(): RunRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE finished_at IS NOT NULL AND status IN ('ok', 'partial')
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as RawRun | undefined;
    return row ? toRun(row) : null;
  }

  recentRuns(limit = 20): RunRow[] {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?')
      .all(limit) as RawRun[];
    return rows.map(toRun);
  }

  // ---------------------------------------------------------------- snapshot

  replaceSnapshot(runId: number, items: SnapshotItem[]): void {
    const insert = this.db.prepare(
      `INSERT INTO snapshot_items
         (run_id, gitlab_username, mr_url, mr_title, project_path, author, reasons, waiting_since, deliverable, skip_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction((rows: SnapshotItem[]) => {
      this.db.prepare('DELETE FROM snapshot_items WHERE run_id = ?').run(runId);
      for (const item of rows) {
        insert.run(
          runId,
          item.gitlab_username,
          item.mr_url,
          item.mr_title,
          item.project_path,
          item.author,
          JSON.stringify(item.reasons),
          item.waiting_since,
          item.deliverable ? 1 : 0,
          item.skip_reason,
        );
      }
    });
    run(items);
  }

  snapshotForRun(runId: number): SnapshotItem[] {
    const rows = this.db
      .prepare(
        `SELECT gitlab_username, mr_url, mr_title, project_path, author, reasons,
                waiting_since, deliverable, skip_reason
         FROM snapshot_items WHERE run_id = ?
         ORDER BY gitlab_username, waiting_since`,
      )
      .all(runId) as RawSnapshotItem[];
    return rows.map((r) => ({
      ...r,
      reasons: JSON.parse(r.reasons) as string[],
      deliverable: r.deliverable === 1,
    }));
  }

  /** Drops snapshots from every run except the newest, keeping the table small. */
  pruneOldSnapshots(keepRunId: number): void {
    this.db.prepare('DELETE FROM snapshot_items WHERE run_id != ?').run(keepRunId);
  }

  // --------------------------------------------------------------- retention

  prune(auditDays: number, runDays: number): { audit: number; runs: number } {
    const audit = this.db
      .prepare(`DELETE FROM audit_log WHERE at < datetime('now', ?)`)
      .run(`-${auditDays} days`).changes;
    const runs = this.db
      .prepare(`DELETE FROM runs WHERE started_at < datetime('now', ?)`)
      .run(`-${runDays} days`).changes;
    return { audit, runs };
  }
}
