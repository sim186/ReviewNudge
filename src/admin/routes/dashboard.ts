import type { FastifyInstance } from 'fastify';
import { describeSilence, evaluateRunSilence } from '../../domain/silence.js';
import { type AdminContext, redirectWith, render, sourceIp } from '../context.js';
import { html, raw, relativeTime, type SafeHtml } from '../views/layout.js';
import type { RunRow } from '../../db/repo.js';

function statusChip(run: RunRow): SafeHtml {
  const cls =
    run.status === 'ok' ? 'chip ok' : run.status === 'failed' ? 'chip error' : 'chip';
  return html`<span class="${cls}">${run.status}</span>`;
}

export function registerDashboard(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/', async (request, reply) => {
    const config = ctx.provider.resolve();
    const now = new Date();
    const silence = evaluateRunSilence(config.silence, config.schedule.timezone, now);
    const last = ctx.repo.latestRun();
    const runs = ctx.repo.recentRuns(10);
    const next = ctx.scheduler?.nextRun() ?? null;

    const stats = html`
      <div class="stats">
        <div class="stat"><div class="value">${last?.mrs_scanned ?? 0}</div><div class="label">merge requests scanned</div></div>
        <div class="stat"><div class="value">${last?.digests_built ?? 0}</div><div class="label">digests built</div></div>
        <div class="stat"><div class="value">${last?.digests_sent ?? 0}</div><div class="label">digests sent</div></div>
        <div class="stat"><div class="value">${last?.failures ?? 0}</div><div class="label">delivery failures</div></div>
      </div>
    `;

    const history = runs.length
      ? html`
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>Status</th><th>Trigger</th><th class="num">Scanned</th><th class="num">Sent</th><th>Note</th></tr>
              </thead>
              <tbody>
                ${runs.map(
                  (run) => html`<tr>
                    <td>${relativeTime(run.started_at, now)}</td>
                    <td>${raw(statusChip(run))}${run.dry_run ? raw('<span class="chip">dry run</span>') : ''}</td>
                    <td>${run.trigger}</td>
                    <td class="num">${run.mrs_scanned}</td>
                    <td class="num">${run.digests_sent}</td>
                    <td class="muted">${run.error ?? run.skipped_reason ?? ''}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<p class="empty">No runs yet.</p>`;

    const body = html`
      <div class="card">
        <h2>Status</h2>
        <p class="hint">
          Last run ${relativeTime(last?.started_at ?? null, now)} · next scheduled
          ${next ? next.toISOString() : 'not scheduled'} · ${describeSilence(silence)}
        </p>
        ${raw(stats)}
      </div>

      <div class="card">
        <h2>Notifications</h2>
        <p class="hint">
          Pausing stops delivery entirely. Scans keep running, so the Pending page stays accurate
          and the audit log records what was withheld.
        </p>
        <div class="actions">
          <form method="post" action="/pause" class="inline">
            <input type="hidden" name="enabled" value="${config.silence.enabled ? 'false' : 'true'}" />
            <button type="submit" class="${config.silence.enabled ? '' : 'danger'}">
              ${config.silence.enabled ? 'Resume notifications' : 'Pause notifications'}
            </button>
          </form>
          <form method="post" action="/run" class="inline">
            <input type="hidden" name="dry_run" value="true" />
            <button type="submit" class="secondary">Run now (dry run)</button>
          </form>
          <form method="post" action="/run" class="inline">
            <button type="submit" class="secondary">Run now</button>
          </form>
        </div>
      </div>

      <div class="card">
        <h2>Recent runs</h2>
        ${raw(history)}
      </div>
    `;

    return render(ctx, request, reply, { title: 'Dashboard', active: '/' }, body);
  });

  app.post('/pause', async (request, reply) => {
    const enabled = (request.body as Record<string, string>).enabled === 'true';
    const before = ctx.provider.resolve().silence.enabled;

    ctx.repo.setSetting('silence.enabled', enabled);
    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'silence.pause',
      target: 'silence.enabled',
      before,
      after: enabled,
    });

    return redirectWith(reply, '/', {
      kind: 'ok',
      message: enabled ? 'Notifications paused.' : 'Notifications resumed.',
    });
  });

  app.post('/run', async (request, reply) => {
    if (!ctx.scheduler) {
      return redirectWith(reply, '/', { kind: 'error', message: 'The scheduler is not running.' });
    }

    const dryRun = (request.body as Record<string, string>).dry_run === 'true';
    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'run.manual',
      after: { dryRun },
    });

    const summary = await ctx.scheduler.trigger('manual', { dryRun });
    if (!summary) {
      return redirectWith(reply, '/', {
        kind: 'error',
        message: 'A run is already in progress; try again shortly.',
      });
    }

    const message =
      summary.status === 'skipped'
        ? `Run finished without delivering: ${summary.skippedReason}.`
        : `Run finished: ${summary.mrsScanned} scanned, ${summary.digestsSent} sent${
            summary.failures ? `, ${summary.failures} failed` : ''
          }${dryRun ? ' (dry run)' : ''}.`;

    return redirectWith(reply, '/', {
      kind: summary.failures > 0 ? 'error' : 'ok',
      message,
    });
  });
}
