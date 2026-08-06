import type { FastifyInstance } from 'fastify';
import type { ExclusionKind } from '../../db/repo.js';
import { normaliseMrUrl } from '../../domain/filters.js';
import type { ExclusionEntry } from '../../config/effective.js';
import { type AdminContext, formValue, redirectWith, render, sourceIp } from '../context.js';
import { html, raw, type SafeHtml } from '../views/layout.js';

interface Section {
  kind: ExclusionKind;
  title: string;
  hint: string;
  placeholder: string;
}

const SECTIONS: Section[] = [
  {
    kind: 'project',
    title: 'Projects',
    hint: 'Full project paths. `*` matches one path segment, `**` matches any depth — `sandbox/**` covers the sandbox group and everything under it.',
    placeholder: 'sandbox/**',
  },
  {
    kind: 'user',
    title: 'Users',
    hint: 'GitLab usernames, never notified and never counted as blocking. Globs work here too, such as `svc-*`.',
    placeholder: 'renovate-bot',
  },
  {
    kind: 'mr_label',
    title: 'Merge request labels',
    hint: 'A merge request carrying any of these labels is skipped entirely.',
    placeholder: 'blocked',
  },
  {
    kind: 'muted_mr',
    title: 'Muted merge requests',
    hint: 'Individual merge request URLs. Sub-pages and query strings are ignored, so a link copied from the browser works.',
    placeholder: 'https://gitlab.example.com/group/project/-/merge_requests/42',
  },
];

function renderSection(section: Section, entries: ExclusionEntry[]): SafeHtml {
  const rows = entries.length
    ? entries
        .map(
          (entry) => html`<tr>
            <td><code>${entry.pattern}</code></td>
            <td>
              ${entry.origin === 'file'
                ? html`<span class="chip file">config.yaml</span>`
                : html`<span class="chip">panel</span>`}
              ${entry.note ? html`<span class="muted">${entry.note}</span>` : ''}
            </td>
            <td class="num">
              ${entry.id === null
                ? html`<span class="muted">edit config.yaml to remove</span>`
                : raw(html`<form method="post" action="/exclusions/remove" class="inline">
                    <input type="hidden" name="id" value="${entry.id}" />
                    <button type="submit" class="danger">Remove</button>
                  </form>`)}
            </td>
          </tr>`,
        )
        .join('')
    : html`<tr><td colspan="3" class="empty">Nothing excluded.</td></tr>`;

  return html`
    <div class="card">
      <h2>${section.title}</h2>
      <p class="hint">${section.hint}</p>
      <form method="post" action="/exclusions/add" class="row">
        <input type="hidden" name="kind" value="${section.kind}" />
        <div class="field">
          <label for="pattern-${section.kind}">Pattern</label>
          <input id="pattern-${section.kind}" name="pattern" placeholder="${section.placeholder}" required size="42" />
        </div>
        <div class="field">
          <label for="note-${section.kind}">Note (optional)</label>
          <input id="note-${section.kind}" name="note" placeholder="why" size="24" />
        </div>
        <button type="submit">Add</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Pattern</th><th>Origin</th><th class="num"></th></tr></thead>
          <tbody>
            ${raw(rows)}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function isExclusionKind(value: string | null): value is ExclusionKind {
  return value === 'project' || value === 'user' || value === 'mr_label' || value === 'muted_mr';
}

export function registerExclusions(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/exclusions', async (request, reply) => {
    const intro = html`
      <div class="card">
        <h2>Exclusions</h2>
        <p class="hint">
          Entries from <code>config.yaml</code> are shown for reference and can only be changed
          there. Anything added here is stored in the database and applies from the next scan.
        </p>
      </div>
    `;

    const body = html`
      ${intro}
      ${SECTIONS.map((section) => renderSection(section, ctx.provider.exclusionEntries(section.kind)))}
    `;

    return render(ctx, request, reply, { title: 'Exclusions', active: '/exclusions' }, body);
  });

  app.post('/exclusions/add', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const kind = formValue(body.kind);
    let pattern = formValue(body.pattern);
    const note = formValue(body.note);

    if (!isExclusionKind(kind) || !pattern) {
      return redirectWith(reply, '/exclusions', { kind: 'error', message: 'Give a kind and a pattern.' });
    }
    if (kind === 'muted_mr') {
      pattern = normaliseMrUrl(pattern);
    }

    const added = ctx.repo.addExclusion(kind, pattern, note, 'admin');
    if (!added) {
      return redirectWith(reply, '/exclusions', {
        kind: 'error',
        message: `"${pattern}" is already excluded.`,
      });
    }

    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'exclusion.add',
      target: `${kind}:${pattern}`,
      after: { kind, pattern, note },
    });

    return redirectWith(reply, '/exclusions', { kind: 'ok', message: `Added "${pattern}".` });
  });

  app.post('/exclusions/remove', async (request, reply) => {
    const id = Number(formValue((request.body as Record<string, unknown>).id));
    if (!Number.isInteger(id)) {
      return redirectWith(reply, '/exclusions', { kind: 'error', message: 'Invalid entry.' });
    }

    const removed = ctx.repo.removeExclusion(id);
    if (!removed) {
      return redirectWith(reply, '/exclusions', { kind: 'error', message: 'That entry no longer exists.' });
    }

    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'exclusion.remove',
      target: `${removed.kind}:${removed.pattern}`,
      before: { kind: removed.kind, pattern: removed.pattern, note: removed.note },
    });

    return redirectWith(reply, '/exclusions', { kind: 'ok', message: `Removed "${removed.pattern}".` });
  });
}
