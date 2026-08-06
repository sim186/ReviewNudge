import { DateTime } from 'luxon';
import type { QuietHours, Weekday } from '../config/schema.js';

/**
 * All silencing decisions, in one place, in a fixed precedence order:
 *
 *   1. global pause          — the whole run sends nothing
 *   2. quiet hours / non-working day / holiday — the whole run is skipped
 *   3. per-recipient snooze  — that person's digest is dropped
 *   4. muted merge requests and excluded labels — handled in filters.ts, before this
 *
 * Levels 1 and 2 differ on purpose: a pause still scans and records, so the panel's
 * Pending page stays truthful while notifications are held.
 */

export type RunSilenceReason = 'paused' | 'quiet hours' | 'non-working day' | 'holiday';

export interface RunSilenceDecision {
  /** True when nothing may be delivered. */
  silenced: boolean;
  reason?: RunSilenceReason;
  /** A pause still scans; a calendar skip does not. */
  scanAnyway: boolean;
}

export interface SilenceSettings {
  enabled: boolean;
  quiet_hours: QuietHours | null;
  working_days: Weekday[];
  holidays: string[];
}

const WEEKDAY_BY_ISO: Record<number, Weekday> = {
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
  7: 'sun',
};

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * A quiet window may wrap midnight (18:00 → 08:00), which is the common case. Equal
 * start and end is treated as an empty window rather than an all-day blackout, so a
 * half-configured value cannot silently stop every notification.
 */
export function isWithinQuietHours(local: DateTime, quiet: QuietHours): boolean {
  const start = minutesOfDay(quiet.start);
  const end = minutesOfDay(quiet.end);
  if (start === end) return false;

  const now = local.hour * 60 + local.minute;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function evaluateRunSilence(
  settings: SilenceSettings,
  timezone: string,
  now: Date,
): RunSilenceDecision {
  if (settings.enabled) {
    return { silenced: true, reason: 'paused', scanAnyway: true };
  }

  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) {
    // An unusable timezone must not become a silent outage; run and let the log say why.
    return { silenced: false, scanAnyway: true };
  }

  const today = local.toFormat('yyyy-MM-dd');
  if (settings.holidays.includes(today)) {
    return { silenced: true, reason: 'holiday', scanAnyway: false };
  }

  const weekday = WEEKDAY_BY_ISO[local.weekday];
  if (settings.working_days.length > 0 && weekday && !settings.working_days.includes(weekday)) {
    return { silenced: true, reason: 'non-working day', scanAnyway: false };
  }

  if (settings.quiet_hours && isWithinQuietHours(local, settings.quiet_hours)) {
    return { silenced: true, reason: 'quiet hours', scanAnyway: false };
  }

  return { silenced: false, scanAnyway: true };
}

/**
 * Snooze runs to the start of `snoozeUntil` in the configured timezone: someone
 * snoozed until 2026-09-01 is quiet through 31 August and hears from us on 1 September.
 */
export function isSnoozed(
  snoozeUntil: string | null,
  timezone: string,
  now: Date,
): boolean {
  if (!snoozeUntil) return false;
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) return false;
  const until = DateTime.fromISO(snoozeUntil, { zone: timezone }).startOf('day');
  if (!until.isValid) return false;
  return local.startOf('day') < until;
}

/** Human-readable description of the next moment a run could deliver. */
export function describeSilence(decision: RunSilenceDecision): string {
  switch (decision.reason) {
    case 'paused':
      return 'notifications are paused';
    case 'quiet hours':
      return 'inside configured quiet hours';
    case 'non-working day':
      return 'today is not a configured working day';
    case 'holiday':
      return 'today is a configured holiday';
    default:
      return 'not silenced';
  }
}
