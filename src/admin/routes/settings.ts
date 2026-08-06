import { Cron } from 'croner';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { SETTING_SCHEMAS, isSettingKey, type SettingKey } from '../../config/effective.js';
import { databasePath } from '../../db/migrate.js';
import { type AdminContext, formValue, redirectWith, render, sourceIp } from '../context.js';
import { html, raw } from '../views/layout.js';

const RULE_LABELS: Record<string, string> = {
  'rules.reviewer_not_approved': 'Reviewer has not approved',
  'rules.assignee_action_pending': 'Assignee has something to do',
  'rules.unresolved_threads': 'Unresolved threads they are on the hook for',
  'rules.require_activity_since_push': 'Skip people who already acted since the last push',
  'rules.ignore_draft': 'Ignore draft merge requests',
  'exclude.bots': 'Ignore bot accounts',
};

function redact(value: string | undefined | null): string {
  if (!value) return 'not set';
  return `${'•'.repeat(8)} (${value.length} chars)`;
}

export function registerSettings(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/settings', async (request, reply) => {
    const config = ctx.provider.resolve();
    const file = ctx.provider.fileConfig;

    const overridden = (key: SettingKey) =>
      ctx.provider.hasOverride(key)
        ? html`<span class="chip">overridden</span>`
        : html`<span class="chip file">config.yaml</span>`;

    let nextRun: string;
    try {
      nextRun =
        new Cron(config.schedule.cron, { timezone: config.schedule.timezone })
          .nextRun()
          ?.toISOString() ?? 'never';
    } catch {
      nextRun = 'invalid expression';
    }

    const toggles = Object.entries(RULE_LABELS)
      .map(([key, label]) => {
        const current = key.startsWith('rules.')
          ? (config.rules as unknown as Record<string, boolean>)[key.slice('rules.'.length)]
          : config.exclude.bots;
        return html`<label>
          <input type="checkbox" name="${key}" ${current ? 'checked' : ''} />
          ${label} ${raw(overridden(key as SettingKey))}
        </label>`;
      })
      .join('');

    const body = html`
      <div class="card">
        <h2>Schedule</h2>
        <p class="hint">
          Standard five-field cron, evaluated in the chosen timezone. Next run: <code>${nextRun}</code>.
        </p>
        <form method="post" action="/settings/schedule" class="row">
          <div class="field">
            <label for="cron">Cron ${raw(overridden('schedule.cron'))}</label>
            <input id="cron" name="cron" value="${config.schedule.cron}" size="18" required />
          </div>
          <div class="field">
            <label for="timezone">Timezone ${raw(overridden('schedule.timezone'))}</label>
            <input id="timezone" name="timezone" value="${config.schedule.timezone}" size="22" required />
          </div>
          <button type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h2>Rules</h2>
        <p class="hint">Which signals count as "waiting for their input".</p>
        <form method="post" action="/settings/rules">
          <fieldset>
            <legend>Signals</legend>
            <div class="checks">${raw(toggles)}</div>
          </fieldset>
          <div class="row">
            <div class="field">
              <label for="min_age_hours">
                Ignore merge requests younger than (hours) ${raw(overridden('rules.min_age_hours'))}
              </label>
              <input id="min_age_hours" name="rules.min_age_hours" type="number" min="0" step="1"
                     value="${config.rules.min_age_hours}" />
            </div>
            <div class="field">
              <label for="max_items">
                Maximum items per digest ${raw(overridden('notifications.max_items_per_digest'))}
              </label>
              <input id="max_items" name="notifications.max_items_per_digest" type="number" min="1" step="1"
                     value="${config.notifications.max_items_per_digest}" />
            </div>
            <button type="submit">Save</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2>From config.yaml</h2>
        <p class="hint">
          Infrastructure and secrets live in the config file and are never editable here. Change
          them there and restart.
        </p>
        <div class="table-wrap">
          <table>
            <tbody>
              <tr><td>GitLab URL</td><td><code>${file.gitlab.url}</code></td></tr>
              <tr><td>GitLab token</td><td><code>${redact(file.gitlab.token)}</code></td></tr>
              <tr><td>Groups</td><td><code>${file.gitlab.groups.join(', ')}</code></td></tr>
              <tr><td>Channels</td><td><code>${config.notifications.channels.join(', ') || 'none'}</code></td></tr>
              <tr><td>SMTP host</td><td><code>${file.email?.smtp.host ?? 'not configured'}</code></td></tr>
              <tr><td>SMTP password</td><td><code>${redact(file.email?.smtp.pass)}</code></td></tr>
              <tr><td>Mail from</td><td><code>${file.email?.from ?? 'not configured'}</code></td></tr>
              <tr><td>Teams workflow URL</td><td><code>${redact(file.teams?.workflow_url)}</code></td></tr>
              <tr><td>Database</td><td><code>${databasePath()}</code></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Reset</h2>
        <p class="hint">Discards panel overrides and falls back to the config file values.</p>
        <form method="post" action="/settings/reset">
          <button type="submit" class="danger">Reset all overrides to config.yaml</button>
        </form>
      </div>
    `;

    return render(ctx, request, reply, { title: 'Settings', active: '/settings' }, body);
  });

  app.post('/settings/schedule', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const cron = formValue(body.cron);
    const timezone = formValue(body.timezone);

    if (!cron || !timezone) {
      return redirectWith(reply, '/settings', { kind: 'error', message: 'Both fields are required.' });
    }
    if (!DateTime.local().setZone(timezone).isValid) {
      return redirectWith(reply, '/settings', {
        kind: 'error',
        message: `"${timezone}" is not a known timezone. Use an IANA name such as Europe/Zurich.`,
      });
    }
    try {
      // Rejecting a bad expression here keeps a typo from silently stopping the schedule.
      new Cron(cron, { timezone }).nextRun();
    } catch {
      return redirectWith(reply, '/settings', {
        kind: 'error',
        message: `"${cron}" is not a valid cron expression.`,
      });
    }

    const before = ctx.provider.resolve().schedule;
    ctx.repo.setSetting('schedule.cron', cron);
    ctx.repo.setSetting('schedule.timezone', timezone);
    ctx.scheduler?.reschedule();

    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'setting.schedule',
      target: 'schedule',
      before: { cron: before.cron, timezone: before.timezone },
      after: { cron, timezone },
    });

    return redirectWith(reply, '/settings', { kind: 'ok', message: 'Schedule saved.' });
  });

  app.post('/settings/rules', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const before = {
      rules: ctx.provider.resolve().rules,
      bots: ctx.provider.resolve().exclude.bots,
      maxItems: ctx.provider.resolve().notifications.max_items_per_digest,
    };

    // Unchecked checkboxes are simply absent from a form post, so every toggle is
    // written explicitly rather than inferred from what arrived.
    for (const key of Object.keys(RULE_LABELS)) {
      if (isSettingKey(key)) ctx.repo.setSetting(key, body[key] !== undefined);
    }

    const numbers: [SettingKey, unknown][] = [
      ['rules.min_age_hours', body['rules.min_age_hours']],
      ['notifications.max_items_per_digest', body['notifications.max_items_per_digest']],
    ];
    for (const [key, value] of numbers) {
      const parsed = SETTING_SCHEMAS[key].safeParse(Number(value));
      if (!parsed.success) {
        return redirectWith(reply, '/settings', {
          kind: 'error',
          message: `${key}: ${parsed.error.issues[0]!.message}`,
        });
      }
      ctx.repo.setSetting(key, parsed.data);
    }

    const after = {
      rules: ctx.provider.resolve().rules,
      bots: ctx.provider.resolve().exclude.bots,
      maxItems: ctx.provider.resolve().notifications.max_items_per_digest,
    };

    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'setting.rules',
      target: 'rules',
      before,
      after,
    });

    return redirectWith(reply, '/settings', { kind: 'ok', message: 'Rules saved.' });
  });

  app.post('/settings/reset', async (request, reply) => {
    const before = ctx.repo.allSettings();
    for (const key of Object.keys(SETTING_SCHEMAS)) {
      ctx.repo.deleteSetting(key);
    }
    ctx.scheduler?.reschedule();

    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'setting.reset',
      target: 'all',
      before,
      after: null,
      detail: 'reverted every override to the config.yaml value',
    });

    return redirectWith(reply, '/settings', {
      kind: 'ok',
      message: 'All overrides cleared; config.yaml values are in effect.',
    });
  });
}

/** The setting keys this page is allowed to write. */
export const EDITABLE_RULE_KEYS = Object.keys(RULE_LABELS).filter(isSettingKey);
