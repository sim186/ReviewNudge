import type { FastifyInstance } from 'fastify';
import type { AuditRow } from '../../db/audit.js';
import { type AdminContext, render } from '../context.js';
import { html, raw, relativeTime, type SafeHtml } from '../views/layout.js';

const PAGE_SIZE = 50;

function summarise(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > 120 ? `${json.slice(0, 119)}…` : json;
  }
  return String(value);
}

function row(entry: AuditRow, now: Date): SafeHtml {
  const changed = entry.before !== null || entry.after !== null;

  return html`<tr>
    <td title="${entry.at}">${relativeTime(entry.at, now)}</td>
    <td>
      ${entry.actor}
      ${entry.source_ip ? html`<div class="muted">${entry.source_ip}</div>` : ''}
    </td>
    <td>
      <code>${entry.action}</code>
      ${entry.outcome === 'error' ? html`<span class="chip error">error</span>` : ''}
    </td>
    <td>${entry.target ?? '—'}</td>
    <td>
      ${changed
        ? html`<code>${summarise(entry.before)}</code> → <code>${summarise(entry.after)}</code>`
        : html`<span class="muted">${entry.detail ?? '—'}</span>`}
      ${changed && entry.detail ? html`<div class="muted">${entry.detail}</div>` : ''}
    </td>
  </tr>`;
}

export function registerAudit(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/audit', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(query.page ?? '1') || 1);
    const filter = {
      actor: query.actor || undefined,
      action: query.action || undefined,
      since: query.since ? `${query.since} 00:00:00` : undefined,
      until: query.until ? `${query.until} 23:59:59` : undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    };

    const entries = ctx.audit.list(filter);
    const total = ctx.audit.count(filter);
    const now = new Date();

    // Group the action list by prefix so the dropdown offers "exclusion" as well as
    // "exclusion.add" — the filter is a prefix match.
    const prefixes = [...new Set(ctx.audit.actions().map((a) => a.split('.')[0]!))].sort();

    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pageLink = (n: number, label: string) => {
      const params = new URLSearchParams();
      if (query.actor) params.set('actor', query.actor);
      if (query.action) params.set('action', query.action);
      if (query.since) params.set('since', query.since);
      if (query.until) params.set('until', query.until);
      params.set('page', String(n));
      return html`<a href="/audit?${params.toString()}">${label}</a>`;
    };

    const body = html`
      <div class="card">
        <h2>Audit</h2>
        <p class="hint">
          Every configuration change and every delivery attempt, append-only. ${total} matching
          ${total === 1 ? 'entry' : 'entries'}.
        </p>
        <form method="get" action="/audit" class="row">
          <div class="field">
            <label for="actor">Actor</label>
            <select id="actor" name="actor">
              <option value="">any</option>
              ${['admin', 'recipient', 'scheduler', 'cli', 'system'].map(
                (a) => html`<option value="${a}" ${query.actor === a ? 'selected' : ''}>${a}</option>`,
              )}
            </select>
          </div>
          <div class="field">
            <label for="action">Action</label>
            <select id="action" name="action">
              <option value="">any</option>
              ${prefixes.map(
                (p) => html`<option value="${p}" ${query.action === p ? 'selected' : ''}>${p}</option>`,
              )}
            </select>
          </div>
          <div class="field">
            <label for="since">From</label>
            <input id="since" name="since" type="date" value="${query.since ?? ''}" />
          </div>
          <div class="field">
            <label for="until">To</label>
            <input id="until" name="until" type="date" value="${query.until ?? ''}" />
          </div>
          <button type="submit">Filter</button>
          <a href="/audit"><button type="button" class="secondary">Clear</button></a>
        </form>
      </div>

      <div class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Change</th></tr>
            </thead>
            <tbody>
              ${entries.length
                ? entries.map((entry) => raw(row(entry, now)))
                : raw(html`<tr><td colspan="5" class="empty">Nothing recorded yet.</td></tr>`)}
            </tbody>
          </table>
        </div>
        ${pages > 1
          ? html`<p class="hint">
              Page ${page} of ${pages}
              ${page > 1 ? raw(` · ${pageLink(page - 1, 'previous')}`) : ''}
              ${page < pages ? raw(` · ${pageLink(page + 1, 'next')}`) : ''}
            </p>`
          : ''}
      </div>
    `;

    return render(ctx, request, reply, { title: 'Audit', active: '/audit' }, body);
  });
}
