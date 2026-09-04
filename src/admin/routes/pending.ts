import type { FastifyInstance } from 'fastify';
import type { SnapshotItem } from '../../db/repo.js';
import { normaliseMrUrl } from '../../domain/filters.js';
import { type AdminContext, formValue, redirectWith, render, sourceIp } from '../context.js';
import { html, raw, relativeTime, type SafeHtml } from '../views/layout.js';

const KIND_LABEL: Record<string, string> = {
  REVIEW_REQUESTED: 'Review',
  ASSIGNEE_ACTION: 'Assignee',
  UNRESOLVED_THREAD: 'Thread',
  MENTIONED: 'Mention',
  MR_WARNING: 'Unattended',
};

function waitingDays(iso: string, now: Date): number {
  const ms = now.getTime() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : 0;
}

function groupByUser(items: SnapshotItem[]): Map<string, SnapshotItem[]> {
  const grouped = new Map<string, SnapshotItem[]>();
  for (const item of items) {
    const list = grouped.get(item.gitlab_username);
    if (list) list.push(item);
    else grouped.set(item.gitlab_username, [item]);
  }
  return grouped;
}

function renderPerson(
  username: string,
  items: SnapshotItem[],
  now: Date,
): SafeHtml {
  const blocked = items[0]?.deliverable === false;
  const skipReason = items[0]?.skip_reason;

  const rows = items
    .slice()
    .sort((a, b) => Date.parse(a.waiting_since) - Date.parse(b.waiting_since))
    .map((item) => {
      const days = waitingDays(item.waiting_since, now);
      const chips = item.reasons
        .map((kind) => html`<span class="chip">${KIND_LABEL[kind] ?? kind}</span>`)
        .join('');

      return html`<tr>
        <td>
          <a href="${item.mr_url}" target="_blank" rel="noreferrer noopener">${item.mr_title}</a>
          <div class="muted">${item.project_path}${item.author ? ` · by ${item.author}` : ''}</div>
        </td>
        <td>${raw(chips)}</td>
        <td class="num">
          <span class="${days >= 7 ? 'chip urgent' : 'chip'}">${days === 0 ? 'today' : `${days}d`}</span>
        </td>
        <td class="num">
          <form method="post" action="/pending/mute" class="inline">
            <input type="hidden" name="url" value="${item.mr_url}" />
            <button type="submit" class="danger">Mute</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');

  return html`
    <div class="card">
      <h2>
        ${username}
        ${blocked ? html`<span class="chip error">not delivered — ${skipReason}</span>` : ''}
      </h2>
      <p class="hint">${items.length} merge ${items.length === 1 ? 'request' : 'requests'} waiting.</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Merge request</th><th>Why</th><th class="num">Waiting</th><th class="num"></th></tr>
          </thead>
          <tbody>
            ${raw(rows)}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function registerPending(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/pending', async (request, reply) => {
    const now = new Date();
    const run = ctx.repo.latestCompletedRun();
    const items = run ? ctx.repo.snapshotForRun(run.id) : [];

    const grouped = groupByUser(items);
    // Undeliverable people first: an unmapped blocker is the actionable thing here.
    const ordered = [...grouped.entries()].sort(([, a], [, b]) => {
      const aBlocked = a[0]?.deliverable === false ? 0 : 1;
      const bBlocked = b[0]?.deliverable === false ? 0 : 1;
      if (aBlocked !== bBlocked) return aBlocked - bBlocked;
      return b.length - a.length;
    });

    const header = html`
      <div class="card">
        <h2>Pending</h2>
        <p class="hint">
          ${run
            ? `From the run ${relativeTime(run.started_at, now)} — ${items.length} outstanding items across ${grouped.size} people.`
            : 'No completed run yet. Use Refresh to scan now.'}
        </p>
        <div class="actions">
          <form method="post" action="/run" class="inline">
            <input type="hidden" name="dry_run" value="true" />
            <button type="submit">Refresh (scan without sending)</button>
          </form>
        </div>
      </div>
    `;

    const body = html`
      ${header}
      ${ordered.length > 0
        ? ordered.map(([username, list]) => renderPerson(username, list, now))
        : html`<div class="card"><p class="empty">Nothing is waiting on anyone.</p></div>`}
    `;

    return render(ctx, request, reply, { title: 'Pending', active: '/pending' }, body);
  });

  app.post('/pending/mute', async (request, reply) => {
    const url = formValue((request.body as Record<string, unknown>).url);
    if (!url) {
      return redirectWith(reply, '/pending', { kind: 'error', message: 'No merge request given.' });
    }

    const normalised = normaliseMrUrl(url);
    const added = ctx.repo.addExclusion('muted_mr', normalised, 'muted from the Pending page', 'admin');
    if (!added) {
      return redirectWith(reply, '/pending', { kind: 'error', message: 'That merge request is already muted.' });
    }

    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'exclusion.add',
      target: `muted_mr:${normalised}`,
      after: { kind: 'muted_mr', pattern: normalised },
    });

    return redirectWith(reply, '/pending', {
      kind: 'ok',
      message: 'Muted. It will drop out of the next scan.',
    });
  });
}
