import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WEEKDAYS, weekdaySchema } from '../../config/schema.js';
import { describeSilence, evaluateRunSilence } from '../../domain/silence.js';
import { type AdminContext, formList, formValue, redirectWith, render, sourceIp } from '../context.js';
import { html, raw } from '../views/layout.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use a 24-hour time such as 18:00');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use a date such as 2026-12-25');

export function registerSilence(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/silence', async (request, reply) => {
    const config = ctx.provider.resolve();
    const now = new Date();
    const decision = evaluateRunSilence(config.silence, config.schedule.timezone, now);
    const quiet = config.silence.quiet_hours;

    const holidays = config.silence.holidays.length
      ? config.silence.holidays
          .map(
            (date) => html`<tr>
              <td><code>${date}</code></td>
              <td class="num">
                <form method="post" action="/silence/holiday/remove" class="inline">
                  <input type="hidden" name="date" value="${date}" />
                  <button type="submit" class="danger">Remove</button>
                </form>
              </td>
            </tr>`,
          )
          .join('')
      : html`<tr><td colspan="2" class="empty">No holidays configured.</td></tr>`;

    const body = html`
      <div class="card">
        <h2>Right now</h2>
        <p class="hint">
          Evaluated in ${config.schedule.timezone}: ${describeSilence(decision)}.
          ${decision.silenced && decision.scanAnyway
            ? 'Scans continue and results appear on the Pending page.'
            : ''}
        </p>
        <p class="hint">
          Order of precedence: global pause, then holiday, then non-working day, then quiet hours,
          then a person's snooze, then muted merge requests.
        </p>
        <form method="post" action="/pause" class="inline">
          <input type="hidden" name="enabled" value="${config.silence.enabled ? 'false' : 'true'}" />
          <button type="submit" class="${config.silence.enabled ? '' : 'danger'}">
            ${config.silence.enabled ? 'Resume notifications' : 'Pause notifications'}
          </button>
        </form>
      </div>

      <div class="card">
        <h2>Quiet hours</h2>
        <p class="hint">
          Runs falling inside this window are skipped entirely. The window may wrap midnight.
          Clear both fields to switch the check off.
        </p>
        <form method="post" action="/silence/quiet-hours" class="row">
          <div class="field">
            <label for="quiet-start">From</label>
            <input id="quiet-start" name="start" type="time" value="${quiet?.start ?? ''}" />
          </div>
          <div class="field">
            <label for="quiet-end">To</label>
            <input id="quiet-end" name="end" type="time" value="${quiet?.end ?? ''}" />
          </div>
          <button type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h2>Working days</h2>
        <p class="hint">Nothing is delivered on days that are not selected.</p>
        <form method="post" action="/silence/working-days">
          <fieldset>
            <legend>Deliver on</legend>
            <div class="checks">
              ${WEEKDAYS.map(
                (day) => html`<label>
                  <input
                    type="checkbox"
                    name="days"
                    value="${day}"
                    ${config.silence.working_days.includes(day) ? 'checked' : ''}
                  />
                  ${day}
                </label>`,
              )}
            </div>
          </fieldset>
          <button type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h2>Holidays</h2>
        <p class="hint">Whole days with no delivery, in ${config.schedule.timezone}.</p>
        <form method="post" action="/silence/holiday/add" class="row">
          <div class="field">
            <label for="holiday">Date</label>
            <input id="holiday" name="date" type="date" required />
          </div>
          <button type="submit">Add</button>
        </form>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th class="num"></th></tr></thead>
            <tbody>
              ${raw(holidays)}
            </tbody>
          </table>
        </div>
      </div>
    `;

    return render(ctx, request, reply, { title: 'Silence', active: '/silence' }, body);
  });

  app.post('/silence/quiet-hours', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const start = formValue(body.start);
    const end = formValue(body.end);
    const before = ctx.provider.resolve().silence.quiet_hours;

    if (!start && !end) {
      ctx.repo.setSetting('silence.quiet_hours', null);
      ctx.audit.record({
        actor: 'admin',
        sourceIp: sourceIp(request),
        action: 'silence.quiet_hours',
        target: 'silence.quiet_hours',
        before,
        after: null,
      });
      return redirectWith(reply, '/silence', { kind: 'ok', message: 'Quiet hours switched off.' });
    }

    const parsed = z.object({ start: time, end: time }).safeParse({ start, end });
    if (!parsed.success) {
      return redirectWith(reply, '/silence', {
        kind: 'error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }

    ctx.repo.setSetting('silence.quiet_hours', parsed.data);
    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'silence.quiet_hours',
      target: 'silence.quiet_hours',
      before,
      after: parsed.data,
    });

    return redirectWith(reply, '/silence', { kind: 'ok', message: 'Quiet hours saved.' });
  });

  app.post('/silence/working-days', async (request, reply) => {
    const days = formList((request.body as Record<string, unknown>).days);
    const parsed = z.array(weekdaySchema).safeParse(days);
    if (!parsed.success) {
      return redirectWith(reply, '/silence', { kind: 'error', message: 'Invalid day selection.' });
    }

    const before = ctx.provider.resolve().silence.working_days;
    ctx.repo.setSetting('silence.working_days', parsed.data);
    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'silence.working_days',
      target: 'silence.working_days',
      before,
      after: parsed.data,
    });

    return redirectWith(reply, '/silence', {
      kind: 'ok',
      message: parsed.data.length
        ? `Delivering on ${parsed.data.join(', ')}.`
        : 'No working days selected — delivery happens on any day.',
    });
  });

  app.post('/silence/holiday/add', async (request, reply) => {
    const date = formValue((request.body as Record<string, unknown>).date);
    const parsed = isoDate.safeParse(date);
    if (!parsed.success) {
      return redirectWith(reply, '/silence', { kind: 'error', message: parsed.error.issues[0]!.message });
    }

    const before = ctx.provider.resolve().silence.holidays;
    if (before.includes(parsed.data)) {
      return redirectWith(reply, '/silence', { kind: 'error', message: 'That date is already listed.' });
    }

    const after = [...before, parsed.data].sort();
    ctx.repo.setSetting('silence.holidays', after);
    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'silence.holidays',
      target: parsed.data,
      before,
      after,
    });

    return redirectWith(reply, '/silence', { kind: 'ok', message: `Added ${parsed.data}.` });
  });

  app.post('/silence/holiday/remove', async (request, reply) => {
    const date = formValue((request.body as Record<string, unknown>).date);
    const before = ctx.provider.resolve().silence.holidays;
    if (!date || !before.includes(date)) {
      return redirectWith(reply, '/silence', { kind: 'error', message: 'That date is not listed.' });
    }

    const after = before.filter((d) => d !== date);
    ctx.repo.setSetting('silence.holidays', after);
    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'silence.holidays',
      target: date,
      before,
      after,
    });

    return redirectWith(reply, '/silence', { kind: 'ok', message: `Removed ${date}.` });
  });
}
