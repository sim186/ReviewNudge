import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { channelSchema } from '../../config/schema.js';
import type { RecipientRow } from '../../db/repo.js';
import { isSnoozed } from '../../domain/silence.js';
import { type AdminContext, formList, formValue, redirectWith, render, sourceIp } from '../context.js';
import { html, raw } from '../views/layout.js';

const recipientForm = z.object({
  gitlab_username: z.string().min(1).max(255),
  email: z.string().email().nullable(),
  teams_upn: z.string().min(1).max(255).nullable(),
  channels: z.array(channelSchema).nullable(),
  snooze_until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'snooze date must look like 2026-09-01')
    .nullable(),
});

function recipientRow(r: RecipientRow, timezone: string, now: Date): string {
  const snoozed = isSnoozed(r.snooze_until, timezone, now);

  return html`<tr>
    <td>
      <strong>${r.gitlab_username}</strong>
      ${!r.enabled ? html`<span class="chip">disabled</span>` : ''}
      ${snoozed ? html`<span class="chip">snoozed until ${r.snooze_until}</span>` : ''}
    </td>
    <td>
      <form method="post" action="/recipients/save" class="row">
        <input type="hidden" name="gitlab_username" value="${r.gitlab_username}" />
        <div class="field">
          <label>Email</label>
          <input name="email" type="email" value="${r.email ?? ''}" size="24" placeholder="none" />
        </div>
        <div class="field">
          <label>Teams UPN</label>
          <input name="teams_upn" value="${r.teams_upn ?? ''}" size="24" placeholder="none" />
        </div>
        <div class="field">
          <label>Channels</label>
          <select name="channels" multiple size="2">
            <option value="email" ${r.channels?.includes('email') ? 'selected' : ''}>email</option>
            <option value="teams" ${r.channels?.includes('teams') ? 'selected' : ''}>teams</option>
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
                          <div class="field">
                            <label>Email</label>
                            <input name="email" type="email" size="24" />
                          </div>
                          <div class="field">
                            <label>Teams UPN</label>
                            <input name="teams_upn" size="24" />
                          </div>
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
      : '';

    const listCard = html`
      <div class="card">
        <h2>Recipients</h2>
        <p class="hint">
          Default channels: ${config.notifications.channels.join(', ') || 'none'}. Leave a
          recipient's channel selection empty to use those. A channel with no matching address is
          skipped automatically.
        </p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Username</th><th>Delivery</th><th class="num"></th></tr></thead>
            <tbody>
              ${recipients.length
                ? recipients.map((r) => raw(recipientRow(r, config.schedule.timezone, now)))
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
          <div class="field">
            <label for="new-email">Email</label>
            <input id="new-email" name="email" type="email" size="26" />
          </div>
          <div class="field">
            <label for="new-teams">Teams UPN</label>
            <input id="new-teams" name="teams_upn" size="26" />
          </div>
          <button type="submit">Add</button>
        </form>
      </div>
    `;

    return render(
      ctx,
      request,
      reply,
      { title: 'Recipients', active: '/recipients' },
      unmappedCard + listCard + addCard,
    );
  });

  app.post('/recipients/save', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const channels = formList(body.channels);

    const parsed = recipientForm.safeParse({
      gitlab_username: formValue(body.gitlab_username) ?? '',
      email: formValue(body.email),
      teams_upn: formValue(body.teams_upn),
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
