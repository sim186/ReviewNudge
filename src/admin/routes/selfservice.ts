import type { FastifyInstance, FastifyReply } from 'fastify';
import { DateTime } from 'luxon';
import { normaliseMrUrl } from '../../domain/filters.js';
import {
  MUTE_CHOICES,
  baselineOf,
  evaluateMute,
  findMuteChoice,
  resolveMuteChoice,
} from '../../domain/mutes.js';
import { isSnoozed } from '../../domain/silence.js';
import { verifyRecipientToken } from '../../notify/tokens.js';
import { type AdminContext, formValue, sourceIp } from '../context.js';
import { html, type SafeHtml } from '../views/layout.js';
import { disabledPage, expiredLinkPage, recipientPage } from '../views/selfservice.js';

/** Snooze-everything durations. No indefinite option: silence has to end by itself. */
const SNOOZE_CHOICES = [
  { value: '1d', label: 'Until tomorrow', days: 1 },
  { value: '3d', label: 'For 3 days', days: 3 },
  { value: '1w', label: 'For 1 week', days: 7 },
  { value: '2w', label: 'For 2 weeks', days: 14 },
  { value: 'date', label: 'Until a date I choose', days: 0 },
];

export interface SelfServiceOptions {
  /** The signing secret. Empty means self-service is unavailable. */
  secret: string;
}

function sendPage(reply: FastifyReply, body: string, status = 200): FastifyReply {
  return reply.status(status).type('text/html; charset=utf-8').send(body);
}

function noticePage(title: string, heading: string, detail: SafeHtml, backLink: string): string {
  return recipientPage(
    title,
    html`<div class="card">
      <h2>${heading}</h2>
      <p class="hint">${detail}</p>
      <a href="${backLink}">Back to your notifications</a>
    </div>`,
  );
}

export function registerSelfService(
  app: FastifyInstance,
  ctx: AdminContext,
  options: SelfServiceOptions,
): void {
  /** Resolves the token, replying with the right page when it does not check out. */
  const resolve = (token: string, reply: FastifyReply): string | null => {
    if (!options.secret) {
      sendPage(reply, disabledPage(), 503);
      return null;
    }
    const username = verifyRecipientToken(token, options.secret);
    if (!username) {
      sendPage(reply, expiredLinkPage(), 404);
      return null;
    }
    return username;
  };

  // ------------------------------------------------------- manage everything

  app.get('/me/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const username = resolve(token, reply);
    if (!username) return reply;

    const config = ctx.provider.resolve();
    const now = new Date();
    const recipient = ctx.repo.getRecipient(username);
    const snoozed = isSnoozed(recipient?.snooze_until ?? null, config.schedule.timezone, now);

    const run = ctx.repo.latestCompletedRun();
    const waiting = run
      ? ctx.repo.snapshotForRun(run.id).filter((i) => i.gitlab_username === username)
      : [];

    const mutes = ctx.repo.listUserMutes(username);
    const active = mutes.filter((m) => {
      // A mute whose merge request is no longer in the last scan cannot be compared
      // against fresh data; keep showing it so it stays revocable.
      const item = waiting.find((i) => normaliseMrUrl(i.mr_url) === normaliseMrUrl(m.mr_url));
      const current = { lastPushAt: item?.waiting_since ?? null, notesCount: null };
      return evaluateMute(m, current, now).suppresses;
    });

    const mutedUrls = new Set(active.map((m) => normaliseMrUrl(m.mr_url)));
    const visible = waiting.filter((i) => !mutedUrls.has(normaliseMrUrl(i.mr_url)));

    const waitingCard = html`
      <div class="card">
        <h2>Waiting for you</h2>
        <p class="hint">
          ${visible.length === 0
            ? 'Nothing is waiting for your input right now.'
            : `${visible.length} merge ${visible.length === 1 ? 'request needs' : 'requests need'} something from you.`}
        </p>
        ${visible.length > 0
          ? html`<div class="table-wrap">
              <table>
                <thead>
                  <tr><th>Merge request</th><th class="num"></th></tr>
                </thead>
                <tbody>
                  ${visible.map(
                    (item) => html`<tr>
                      <td>
                        <a href="${item.mr_url}" target="_blank" rel="noreferrer noopener"
                          >${item.mr_title}</a
                        >
                        <div class="muted">${item.project_path}</div>
                      </td>
                      <td class="num">
                        <a href="/me/${token}/mute?mr=${encodeURIComponent(item.mr_url)}"
                          ><button type="button" class="secondary">Mute this</button></a
                        >
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
          : null}
      </div>
    `;

    const mutesCard = html`
      <div class="card">
        <h2>Muted by you</h2>
        <p class="hint">
          ${active.length === 0
            ? 'You have not muted anything.'
            : 'These stay quiet for you only — everyone else still gets their reminders.'}
        </p>
        ${active.length > 0
          ? html`<div class="table-wrap">
              <table>
                <thead>
                  <tr><th>Merge request</th><th>Muted</th><th class="num"></th></tr>
                </thead>
                <tbody>
                  ${active.map((m) => {
                    const item = waiting.find(
                      (i) => normaliseMrUrl(i.mr_url) === normaliseMrUrl(m.mr_url),
                    );
                    const current = { lastPushAt: item?.waiting_since ?? null, notesCount: null };
                    return html`<tr>
                      <td>
                        <a href="${m.mr_url}" target="_blank" rel="noreferrer noopener"
                          >${m.mr_title ?? m.mr_url}</a
                        >
                      </td>
                      <td class="muted">${evaluateMute(m, current, now).describe}</td>
                      <td class="num">
                        <form method="post" action="/me/${token}/unmute" class="inline">
                          <input type="hidden" name="mr" value="${m.mr_url}" />
                          <button type="submit" class="danger">Un-mute</button>
                        </form>
                      </td>
                    </tr>`;
                  })}
                </tbody>
              </table>
            </div>`
          : null}
      </div>
    `;

    const snoozeCard = html`
      <div class="card">
        <h2>Pause everything</h2>
        ${snoozed
          ? html`<p class="hint">
                All your reminders are paused until <strong>${recipient?.snooze_until}</strong>.
              </p>
              <form method="post" action="/me/${token}/unsnooze">
                <button type="submit">Resume my reminders</button>
              </form>`
          : html`<p class="hint">
                Going away? Pause every reminder for a while. Merge requests keep waiting; you
                just stop hearing about them.
              </p>
              <form method="post" action="/me/${token}/snooze" class="row">
                <div class="field">
                  <label for="how-long">How long</label>
                  <select id="how-long" name="choice">
                    ${SNOOZE_CHOICES.map(
                      (c) => html`<option value="${c.value}">${c.label}</option>`,
                    )}
                  </select>
                </div>
                <div class="field">
                  <label for="snooze-date">Date (if chosen above)</label>
                  <input id="snooze-date" name="date" type="date" />
                </div>
                <button type="submit">Pause</button>
              </form>`}
      </div>
    `;

    return sendPage(
      reply,
      recipientPage(
        `Your notifications`,
        html`
          <div class="card">
            <h2>Hello ${username}</h2>
            <p class="hint">
              Everything here affects you alone. Nothing you do on this page changes what your
              colleagues receive.
            </p>
          </div>
          ${waitingCard}${mutesCard}${snoozeCard}
        `,
      ),
    );
  });

  // ------------------------------------------------- mute confirmation page

  app.get('/me/:token/mute', async (request, reply) => {
    const { token } = request.params as { token: string };
    const username = resolve(token, reply);
    if (!username) return reply;

    const mrUrl = formValue((request.query as Record<string, unknown>).mr);
    if (!mrUrl) {
      return sendPage(
        reply,
        noticePage(
          'Nothing to mute',
          'No merge request given',
          html`The link was incomplete.`,
          `/me/${token}`,
        ),
        400,
      );
    }

    const normalised = normaliseMrUrl(mrUrl);
    const run = ctx.repo.latestCompletedRun();
    const item = run
      ? ctx.repo
          .snapshotForRun(run.id)
          .find(
            (i) =>
              i.gitlab_username === username && normaliseMrUrl(i.mr_url) === normalised,
          )
      : undefined;

    const title = item?.mr_title ?? mrUrl;
    const error = formValue((request.query as Record<string, unknown>).err);

    // A GET only ever shows this form. The mute itself needs the POST below, so a mail
    // scanner following the link cannot mute anything on the recipient's behalf.
    return sendPage(
      reply,
      recipientPage(
        'Mute a merge request',
        html`
          <div class="card">
            <h2>Stop reminders about this?</h2>
            <p class="hint">
              <strong>${title}</strong><br />
              ${item ? html`<span class="muted">${item.project_path}</span>` : null}
            </p>
            ${error ? html`<div class="banner error">${error}</div>` : null}
            <p class="hint">
              This affects your reminders only. Everyone else still gets theirs, and the merge
              request itself is untouched.
            </p>
            <form method="post" action="/me/${token}/mute" class="row">
              <input type="hidden" name="mr" value="${mrUrl}" />
              <input type="hidden" name="title" value="${title}" />
              <div class="field">
                <label for="choice">For how long</label>
                <select id="choice" name="choice">
                  ${MUTE_CHOICES.map((c) => html`<option value="${c.value}">${c.label}</option>`)}
                </select>
              </div>
              <div class="field">
                <label for="date">Date (if chosen above)</label>
                <input id="date" name="date" type="date" />
              </div>
              <button type="submit">Mute it</button>
            </form>
            <p class="hint" style="margin-top:12px;">
              <a href="/me/${token}">Cancel and see all your notifications</a>
            </p>
          </div>
        `,
      ),
    );
  });

  app.post('/me/:token/mute', async (request, reply) => {
    const { token } = request.params as { token: string };
    const username = resolve(token, reply);
    if (!username) return reply;

    const body = request.body as Record<string, unknown>;
    const mrUrl = formValue(body.mr);
    const choiceValue = formValue(body.choice);
    const choice = choiceValue ? findMuteChoice(choiceValue) : null;

    if (!mrUrl || !choice) {
      return sendPage(
        reply,
        noticePage(
          'Could not mute',
          'Something was missing',
          html`Pick how long the mute should last and try again.`,
          `/me/${token}`,
        ),
        400,
      );
    }

    const config = ctx.provider.resolve();
    const now = new Date();
    const resolved = resolveMuteChoice(choice, {
      date: formValue(body.date),
      timezone: config.schedule.timezone,
      now,
    });

    if ('error' in resolved) {
      const back = `/me/${token}/mute?mr=${encodeURIComponent(mrUrl)}&err=${encodeURIComponent(resolved.error)}`;
      return reply.redirect(back, 303);
    }

    const normalised = normaliseMrUrl(mrUrl);
    const run = ctx.repo.latestCompletedRun();
    const item = run
      ? ctx.repo
          .snapshotForRun(run.id)
          .find(
            (i) => i.gitlab_username === username && normaliseMrUrl(i.mr_url) === normalised,
          )
      : undefined;

    const stored = ctx.repo.upsertUserMute({
      gitlab_username: username,
      mr_url: normalised,
      mr_title: formValue(body.title) ?? item?.mr_title ?? null,
      mode: resolved.mode,
      until: resolved.until,
      baseline:
        resolved.mode === 'until_change'
          ? baselineOf({ lastPushAt: item?.waiting_since ?? null, notesCount: null })
          : null,
    });

    ctx.audit.record({
      actor: 'recipient',
      sourceIp: sourceIp(request),
      action: 'mute.add',
      target: `${username}:${normalised}`,
      after: { mode: stored.mode, until: stored.until },
    });

    const describe = evaluateMute(stored, { lastPushAt: null, notesCount: null }, now).describe;

    return sendPage(
      reply,
      noticePage(
        'Muted',
        'Done — you will not hear about this one',
        html`Muted ${describe}. Your colleagues still get their own reminders.`,
        `/me/${token}`,
      ),
    );
  });

  app.post('/me/:token/unmute', async (request, reply) => {
    const { token } = request.params as { token: string };
    const username = resolve(token, reply);
    if (!username) return reply;

    const mrUrl = formValue((request.body as Record<string, unknown>).mr);
    if (!mrUrl) return reply.redirect(`/me/${token}`, 303);

    const removed = ctx.repo.removeUserMute(username, normaliseMrUrl(mrUrl));
    if (removed) {
      ctx.audit.record({
        actor: 'recipient',
        sourceIp: sourceIp(request),
        action: 'mute.remove',
        target: `${username}:${removed.mr_url}`,
        before: { mode: removed.mode, until: removed.until },
      });
    }

    return reply.redirect(`/me/${token}`, 303);
  });

  // --------------------------------------------------------- snooze everything

  app.post('/me/:token/snooze', async (request, reply) => {
    const { token } = request.params as { token: string };
    const username = resolve(token, reply);
    if (!username) return reply;

    const recipient = ctx.repo.getRecipient(username);
    if (!recipient) {
      return sendPage(
        reply,
        noticePage(
          'Not set up',
          'We have no delivery address for you',
          html`There is nothing to pause yet.`,
          `/me/${token}`,
        ),
        404,
      );
    }

    const body = request.body as Record<string, unknown>;
    const choice = SNOOZE_CHOICES.find((c) => c.value === formValue(body.choice));
    const config = ctx.provider.resolve();
    const now = DateTime.fromJSDate(new Date(), { zone: config.schedule.timezone });

    let until: string | null = null;
    if (choice && choice.days > 0) {
      until = now.plus({ days: choice.days }).toFormat('yyyy-MM-dd');
    } else {
      const date = formValue(body.date);
      const parsed = date ? DateTime.fromISO(date, { zone: config.schedule.timezone }) : null;
      if (!parsed?.isValid || parsed.startOf('day') <= now.startOf('day')) {
        return sendPage(
          reply,
          noticePage(
            'Could not pause',
            'Pick a date in the future',
            html`Choose one of the periods, or give a date after today.`,
            `/me/${token}`,
          ),
          400,
        );
      }
      until = parsed.toFormat('yyyy-MM-dd');
    }

    ctx.repo.upsertRecipient({ ...recipient, snooze_until: until });
    ctx.audit.record({
      actor: 'recipient',
      sourceIp: sourceIp(request),
      action: 'snooze.set',
      target: username,
      before: { snooze_until: recipient.snooze_until },
      after: { snooze_until: until },
    });

    return reply.redirect(`/me/${token}`, 303);
  });

  app.post('/me/:token/unsnooze', async (request, reply) => {
    const { token } = request.params as { token: string };
    const username = resolve(token, reply);
    if (!username) return reply;

    const recipient = ctx.repo.getRecipient(username);
    if (recipient) {
      ctx.repo.upsertRecipient({ ...recipient, snooze_until: null });
      ctx.audit.record({
        actor: 'recipient',
        sourceIp: sourceIp(request),
        action: 'snooze.clear',
        target: username,
        before: { snooze_until: recipient.snooze_until },
        after: { snooze_until: null },
      });
    }

    return reply.redirect(`/me/${token}`, 303);
  });
}
