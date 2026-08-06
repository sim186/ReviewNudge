import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { evaluateRunSilence, isSnoozed, isWithinQuietHours, type SilenceSettings } from './silence.js';

const ZURICH = 'Europe/Zurich';

const base: SilenceSettings = {
  enabled: false,
  quiet_hours: null,
  working_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  holidays: [],
};

/** A local wall-clock time in Zurich, as the Date the scheduler would see. */
function at(iso: string, zone = ZURICH): Date {
  return DateTime.fromISO(iso, { zone }).toJSDate();
}

describe('isWithinQuietHours', () => {
  const local = (iso: string) => DateTime.fromISO(iso, { zone: ZURICH });

  it('handles a window that wraps midnight', () => {
    const quiet = { start: '18:00', end: '08:00' };
    expect(isWithinQuietHours(local('2026-08-06T19:00'), quiet)).toBe(true);
    expect(isWithinQuietHours(local('2026-08-06T02:00'), quiet)).toBe(true);
    expect(isWithinQuietHours(local('2026-08-06T09:00'), quiet)).toBe(false);
  });

  it('handles a window inside one day', () => {
    const quiet = { start: '01:00', end: '05:00' };
    expect(isWithinQuietHours(local('2026-08-06T03:00'), quiet)).toBe(true);
    expect(isWithinQuietHours(local('2026-08-06T09:00'), quiet)).toBe(false);
  });

  it('is inclusive of the start and exclusive of the end', () => {
    const quiet = { start: '18:00', end: '08:00' };
    expect(isWithinQuietHours(local('2026-08-06T18:00'), quiet)).toBe(true);
    expect(isWithinQuietHours(local('2026-08-06T08:00'), quiet)).toBe(false);
  });

  it('treats an empty window as no restriction rather than an all-day blackout', () => {
    expect(isWithinQuietHours(local('2026-08-06T12:00'), { start: '09:00', end: '09:00' })).toBe(false);
  });
});

describe('evaluateRunSilence', () => {
  it('lets a normal working morning through', () => {
    const decision = evaluateRunSilence(base, ZURICH, at('2026-08-06T09:00')); // Thursday
    expect(decision).toEqual({ silenced: false, scanAnyway: true });
  });

  it('pauses everything but still scans, so the panel stays truthful', () => {
    const decision = evaluateRunSilence({ ...base, enabled: true }, ZURICH, at('2026-08-06T09:00'));
    expect(decision).toEqual({ silenced: true, reason: 'paused', scanAnyway: true });
  });

  it('takes the pause switch ahead of the calendar checks', () => {
    const settings = { ...base, enabled: true, holidays: ['2026-08-06'] };
    expect(evaluateRunSilence(settings, ZURICH, at('2026-08-06T09:00')).reason).toBe('paused');
  });

  it('skips a configured holiday without scanning', () => {
    const settings = { ...base, holidays: ['2026-12-25'] };
    const decision = evaluateRunSilence(settings, ZURICH, at('2026-12-25T09:00'));
    expect(decision).toEqual({ silenced: true, reason: 'holiday', scanAnyway: false });
  });

  it('skips a non-working day', () => {
    // 2026-08-08 is a Saturday.
    expect(evaluateRunSilence(base, ZURICH, at('2026-08-08T09:00')).reason).toBe('non-working day');
  });

  it('skips inside quiet hours', () => {
    const settings = { ...base, quiet_hours: { start: '18:00', end: '08:00' } };
    expect(evaluateRunSilence(settings, ZURICH, at('2026-08-06T22:00')).reason).toBe('quiet hours');
    expect(evaluateRunSilence(settings, ZURICH, at('2026-08-06T09:00')).silenced).toBe(false);
  });

  it('ranks holiday above non-working day above quiet hours', () => {
    const settings = {
      ...base,
      holidays: ['2026-08-08'],
      quiet_hours: { start: '00:00', end: '23:59' },
    };
    expect(evaluateRunSilence(settings, ZURICH, at('2026-08-08T09:00')).reason).toBe('holiday');
  });

  it('evaluates the calendar in the configured timezone, not UTC', () => {
    // 23:30 Sunday in Zurich is 21:30 Sunday UTC — both Sunday, but the boundary
    // cases only agree if we localise. 00:30 Monday Zurich is 22:30 Sunday UTC.
    const mondayEarly = at('2026-08-10T00:30'); // Monday 00:30 Zurich
    expect(evaluateRunSilence(base, ZURICH, mondayEarly).silenced).toBe(false);
    expect(evaluateRunSilence(base, 'UTC', mondayEarly).reason).toBe('non-working day');
  });

  it('respects wall-clock quiet hours across a DST change', () => {
    const settings = { ...base, quiet_hours: { start: '18:00', end: '08:00' } };
    // Zurich leaves DST on 2026-10-25; 09:00 local is 07:00 UTC before and 08:00 after.
    expect(evaluateRunSilence(settings, ZURICH, at('2026-10-23T09:00')).silenced).toBe(false);
    expect(evaluateRunSilence(settings, ZURICH, at('2026-10-26T09:00')).silenced).toBe(false);
    expect(evaluateRunSilence(settings, ZURICH, at('2026-10-26T07:30')).reason).toBe('quiet hours');
  });

  it('does not silence when the timezone is unusable', () => {
    const decision = evaluateRunSilence(base, 'Not/AZone', at('2026-08-08T09:00'));
    expect(decision.silenced).toBe(false);
  });

  it('treats an empty working_days list as "any day"', () => {
    const settings = { ...base, working_days: [] };
    expect(evaluateRunSilence(settings, ZURICH, at('2026-08-08T09:00')).silenced).toBe(false);
  });
});

describe('isSnoozed', () => {
  it('is quiet before the date and active on it', () => {
    expect(isSnoozed('2026-09-01', ZURICH, at('2026-08-31T23:00'))).toBe(true);
    expect(isSnoozed('2026-09-01', ZURICH, at('2026-09-01T00:30'))).toBe(false);
    expect(isSnoozed('2026-09-01', ZURICH, at('2026-09-02T09:00'))).toBe(false);
  });

  it('is inactive without a snooze date', () => {
    expect(isSnoozed(null, ZURICH, at('2026-08-06T09:00'))).toBe(false);
  });

  it('ignores an unparseable date rather than silencing forever', () => {
    expect(isSnoozed('next tuesday', ZURICH, at('2026-08-06T09:00'))).toBe(false);
  });

  it('uses the configured timezone for the day boundary', () => {
    // 2026-08-31T23:00 Zurich is 21:00 UTC — still 31 August in both, but at
    // 00:30 Zurich on 1 September it is still 22:30 on 31 August in UTC.
    const justAfterMidnightZurich = at('2026-09-01T00:30');
    expect(isSnoozed('2026-09-01', ZURICH, justAfterMidnightZurich)).toBe(false);
    expect(isSnoozed('2026-09-01', 'UTC', justAfterMidnightZurich)).toBe(true);
  });
});
