import type { Db } from './migrate.js';

export type Actor = 'admin' | 'recipient' | 'scheduler' | 'cli' | 'system';

export interface AuditEntry {
  actor: Actor;
  action: string;
  target?: string | null;
  before?: unknown;
  after?: unknown;
  outcome?: 'ok' | 'error';
  detail?: string | null;
  sourceIp?: string | null;
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  source_ip: string | null;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  outcome: string;
  detail: string | null;
}

export interface AuditFilter {
  actor?: string;
  action?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

interface RawAuditRow extends Omit<AuditRow, 'before' | 'after'> {
  before: string | null;
  after: string | null;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Append-only audit trail. Nothing in this class updates or deletes a row — the
 * only removal path is retention pruning in Repo.prune.
 */
export class Audit {
  constructor(private readonly db: Db) {}

  record(entry: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (actor, source_ip, action, target, before, after, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.actor,
        entry.sourceIp ?? null,
        entry.action,
        entry.target ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.outcome ?? 'ok',
        entry.detail ?? null,
      );
  }

  list(filter: AuditFilter = {}): AuditRow[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.actor) {
      where.push('actor = ?');
      params.push(filter.actor);
    }
    if (filter.action) {
      // Prefix match so "exclusion" finds exclusion.add and exclusion.remove.
      where.push('action LIKE ?');
      params.push(`${filter.action}%`);
    }
    if (filter.since) {
      where.push('at >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      where.push('at <= ?');
      params.push(filter.until);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 100, filter.offset ?? 0) as RawAuditRow[];

    return rows.map((r) => ({ ...r, before: parseJson(r.before), after: parseJson(r.after) }));
  }

  count(filter: AuditFilter = {}): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.actor) {
      where.push('actor = ?');
      params.push(filter.actor);
    }
    if (filter.action) {
      where.push('action LIKE ?');
      params.push(`${filter.action}%`);
    }
    if (filter.since) {
      where.push('at >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      where.push('at <= ?');
      params.push(filter.until);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params) as {
      n: number;
    };
    return row.n;
  }

  /** Distinct action names present in the log, for populating the filter dropdown. */
  actions(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT action FROM audit_log ORDER BY action')
      .all() as { action: string }[];
    return rows.map((r) => r.action);
  }
}
