import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CHANNELS, type Channel, channelSchema } from '../../config/schema.js';
import type { RecipientRow } from '../../db/repo.js';
import { isSnoozed } from '../../domain/silence.js';
import { CHANNEL_LIST, CHANNEL_SPECS } from '../../notify/channels.js';
import { availableChannels } from '../../notify/factory.js';
import { type AdminContext, formList, formValue, redirectWith, render, sourceIp } from '../context.js';
import { html, raw, type SafeHtml } from '../views/layout.js';

const recipientForm = z.object({
  gitlab_username: z.string().min(1).max(255),
  email: z.string().email().nullable(),
  teams_upn: z.string().min(1).max(255).nullable(),
  slack_id: z.string().min(1).max(255).nullable(),
  telegram_chat_id: z
    .string()
    .regex(/^-?\d+$/, 'Telegram chat ID is a number, which the person gets by messaging the bot')
    .nullable(),
  channels: z.array(channelSchema).nullable(),
  snooze_until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'snooze date must look like 2026-09-01')
    .nullable(),
});

/**
 * Channels this person has an address for that would never be used, because the
 * channel is switched off in `notifications.channels`. Worth saying out loud: filling
 * in a Telegram chat ID and selecting the channel saves cleanly, sends nothing, and
 * logs nothing, because the channel is dropped long before a notifier is consulted.
 */
function inertChannels(r: RecipientRow, available: readonly Channel[]): Channel[] {
  const requested = r.channels ?? [];
  return CHANNELS.filter(
    (c) => !available.includes(c) && Boolean(CHANNEL_SPECS[c].address(r)) && requested.includes(c),
  );
}

function recipientRow(
  r: RecipientRow,
  timezone: string,
  now: Date,
  available: readonly Channel[],
): SafeHtml {
  const snoozed = isSnoozed(r.snooze_until, timezone, now);
  const inert = inertChannels(r, available);

  return html`<tr>
    <td>
      <strong>${r.gitlab_username}</strong>
      ${!r.enabled ? html`<span class="chip">disabled</span>` : ''}
      ${snoozed ? html`<span class="chip">snoozed until ${r.snooze_until}</span>` : ''}
      ${inert.length
        ? html`<span class="chip urgent"
            >${inert.join(', ')} not enabled</span
          >`
        : ''}
    </td>
    <td>
      <form method="post" action="/recipients/save" class="row">
        <input type="hidden" name="gitlab_username" value="${r.gitlab_username}" />
        ${CHANNEL_LIST.map(
          (spec) => html`<div class="field">
            <label>${spec.label}</label>
            <input
              name="${spec.field.name}"
              type="${spec.field.type}"
              value="${spec.address(r) ?? ''}"
              size="22"
              placeholder="none"
            />
          </div>`,
        )}
        <div class="field">
          <label>Channels</label>
          <select name="channels" multiple size="${CHANNELS.length}">
            ${CHANNEL_LIST.map(
              (spec) =>
                html`<option value="${spec.id}" ${r.channels?.includes(spec.id) ? 'selected' : ''}>
                  ${spec.id}${available.includes(spec.id) ? '' : ' (off)'}
                </option>`,
            )}
          </select>
        </div>
        <div class="field">
          <label>Snooze until</label>
          <input name="snooze_until" type="date" value="${r.snooze_until ?? ''}" />
        </div>
        <button type="submit">Save</button>
      </form>
    </td>
    <td class="num">
      <form method="post" action="/recipients/toggle" class="inline">
        <input type="hidden" name="gitlab_username" value="${r.gitlab_username}" />
        <input type="hidden" name="enabled" value="${r.enabled ? 'false' : 'true'}" />
        <button type="submit" class="secondary">${r.enabled ? 'Disable' : 'Enable'}</button>
      </form>
      <form method="post" action="/recipients/delete" class="inline">
        <input type="hidden" name="gitlab_username" value="${r.gitlab_username}" />
        <button type="submit" class="danger">Delete</button>
      </form>
    </td>
  </tr>`;
}

export function registerRecipients(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/recipients', async (request, reply) => {
    const config = ctx.provider.resolve();
    // Both conditions matter: a channel switched off in settings and a channel with no
    // configuration section are equally incapable of delivering anything.
    const enabledChannels = availableChannels(config);
    const now = new Date();
    const recipients = ctx.repo.listRecipients();
    const known = new Set(recipients.map((r) => r.gitlab_username));

    // Anyone blocking a merge request in the last scan but not in the table. These
    // are the mappings actually worth adding, so they go first with a prefilled form.
    const run = ctx.repo.latestCompletedRun();
    const seen = run ? ctx.repo.snapshotForRun(run.id) : [];
    const unmappedCounts = new Map<string, number>();
    for (const item of seen) {
      if (known.has(item.gitlab_username)) continue;
      unmappedCounts.set(item.gitlab_username, (unmappedCounts.get(item.gitlab_username) ?? 0) + 1);
    }
    const unmapped = [...unmappedCounts.entries()].sort((a, b) => b[1] - a[1]);

    const unmappedCard = unmapped.length
      ? html`
          <div class="card">
            <h2>Unmapped people</h2>
            <p class="hint">
              These GitLab users are blocking merge requests but have no delivery address, so they
              were skipped. Add one to start notifying them.
            </p>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Username</th><th class="num">Blocking</th><th>Add</th></tr></thead>
                <tbody>
                  ${unmapped.map(
                    ([username, count]) => html`<tr>
                      <td><strong>${username}</strong></td>
                      <td class="num">${count}</td>
                      <td>
                        <form method="post" action="/recipients/save" class="row">
                          <input type="hidden" name="gitlab_username" value="${username}" />
                          ${CHANNEL_LIST.map(
                            (spec) => html`<div class="field">
                              <label>${spec.label}</label>
                              <input name="${spec.field.name}" type="${spec.field.type}" size="20" />
                            </div>`,
                          )}
                          <button type="submit">Add</button>
                        </form>
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>
          </div>
        `
      : null;

    const listCard = html`
      <div class="card">
        <h2>Recipients</h2>
        <p class="hint">
          Default channels: ${config.notifications.channels.join(', ') || 'none'}. Leave a
          recipient's channel selection empty to use those. A channel with no matching address is
          skipped automatically. Channels marked <strong>(off)</strong> are not in
          <a href="/settings">Settings → channels</a>, so nothing is delivered on them however
          this page is filled in.
        </p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Username</th><th>Delivery</th><th class="num"></th></tr></thead>
            <tbody>
              ${recipients.length
                ? recipients.map((r) =>
                    raw(recipientRow(r, config.schedule.timezone, now, enabledChannels)),
                  )
                : raw(html`<tr><td colspan="3" class="empty">No recipients yet.</td></tr>`)}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const addCard = html`
      <div class="card">
        <h2>Add someone</h2>
        <form method="post" action="/recipients/save" class="row">
          <div class="field">
            <label for="new-username">GitLab username</label>
            <input id="new-username" name="gitlab_username" required size="20" />
          </div>
          ${CHANNEL_LIST.map(
            (spec) => html`<div class="field">
              <label for="new-${spec.field.name}">${spec.label}</label>
              <input
                id="new-${spec.field.name}"
                name="${spec.field.name}"
                type="${spec.field.type}"
                placeholder="${spec.field.placeholder}"
                size="22"
              />
            </div>`,
          )}
          <button type="submit">Add</button>
        </form>
      </div>
    `;

    return render(
      ctx,
      request,
      reply,
      { title: 'Recipients', active: '/recipients' },
      html`${unmappedCard}${listCard}${addCard}`,
    );
  });

  app.post('/recipients/save', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const channels = formList(body.channels);

    const parsed = recipientForm.safeParse({
      gitlab_username: formValue(body.gitlab_username) ?? '',
      ...Object.fromEntries(
        CHANNEL_LIST.map((spec) => [spec.field.name, formValue(body[spec.field.name])]),
      ),
      channels: channels.length > 0 ? channels : null,
      snooze_until: formValue(body.snooze_until),
    });

    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return redirectWith(reply, '/recipients', { kind: 'error', message });
    }

    const before = ctx.repo.getRecipient(parsed.data.gitlab_username);
    const after = ctx.repo.upsertRecipient({ ...parsed.data, enabled: before?.enabled ?? true });

    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: before ? 'recipient.update' : 'recipient.add',
      target: parsed.data.gitlab_username,
      before,
      after,
    });

    return redirectWith(reply, '/recipients', {
      kind: 'ok',
      message: `Saved ${parsed.data.gitlab_username}.`,
    });
  });

  app.post('/recipients/toggle', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const username = formValue(body.gitlab_username);
    const enabled = body.enabled === 'true';
    if (!username) {
      return redirectWith(reply, '/recipients', { kind: 'error', message: 'No recipient given.' });
    }

    const before = ctx.repo.getRecipient(username);
    if (!before) {
      return redirectWith(reply, '/recipients', { kind: 'error', message: 'No such recipient.' });
    }

    const after = ctx.repo.upsertRecipient({ ...before, enabled });
    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'recipient.update',
      target: username,
      before,
      after,
    });

    return redirectWith(reply, '/recipients', {
      kind: 'ok',
      message: `${username} ${enabled ? 'enabled' : 'disabled'}.`,
    });
  });

  app.post('/recipients/delete', async (request, reply) => {
    const username = formValue((request.body as Record<string, unknown>).gitlab_username);
    if (!username) {
      return redirectWith(reply, '/recipients', { kind: 'error', message: 'No recipient given.' });
    }

    const removed = ctx.repo.deleteRecipient(username);
    if (!removed) {
      return redirectWith(reply, '/recipients', { kind: 'error', message: 'No such recipient.' });
    }

    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'recipient.delete',
      target: username,
      before: removed,
    });

    return redirectWith(reply, '/recipients', { kind: 'ok', message: `Deleted ${username}.` });
  });
}
