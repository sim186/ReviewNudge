import type { FastifyInstance } from 'fastify';
import { GitLabClient } from '../../gitlab/client.js';
import type { GqlProject, GqlGroup } from '../../gitlab/types.js';
import { type AdminContext, formList, redirectWith, render, sourceIp } from '../context.js';
import { html, raw } from '../views/layout.js';

export function registerProjects(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/projects', async (request, reply) => {
    const config = ctx.provider.resolve();
    const scanGroups = new Set(config.gitlab.groups);
    const scanProjects = new Set(config.gitlab.projects);
    const hasProjectOverride = scanProjects.size > 0;

    const client = new GitLabClient({
      url: config.gitlab.url,
      token: config.gitlab.token,
      timeoutMs: config.gitlab.timeout_ms,
      pageSize: config.gitlab.page_size,
      logger: ctx.logger,
    });

    let allGroups: GqlGroup[] = [];
    let groupsError: string | null = null;
    try {
      allGroups = await client.fetchAccessibleGroups();
    } catch (err) {
      groupsError = (err as Error).message;
    }

    const groupsHtml = groupsError
      ? html`<div class="banner error">Could not fetch groups: ${groupsError}</div>`
      : html`
          <form method="post" action="/projects/save" class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="num">Scan</th>
                  <th>Group</th>
                  <th>Path</th>
                </tr>
              </thead>
              <tbody>
                ${allGroups.map(
                  (g) =>
                    html`<tr>
                      <td class="num">
                        <input
                          type="checkbox"
                          name="group"
                          value="${g.fullPath}"
                          ${scanGroups.has(g.fullPath) ? 'checked' : ''}
                        />
                      </td>
                      <td>${g.name}${g.parent ? raw(html` <span class="chip">subgroup of ${g.parent.fullPath}</span>`) : ''}</td>
                      <td><code>${g.fullPath}</code></td>
                    </tr>`,
                )}
              </tbody>
            </table>
            <div class="actions">
              <button type="submit">Save scan groups</button>
              ${ctx.provider.hasOverride('gitlab.groups')
                ? raw(html`<button type="submit" formaction="/projects/reset-groups" class="secondary" onclick="return confirm('Reset scan groups to config.yaml?')">Reset</button>`)
                : ''}
            </div>
          </form>`;

    let projectGroups: { groupPath: string; groupName: string; projects: GqlProject[]; error?: string }[] = [];
    let totalProjects = 0;
    let hasErrors = false;

    if (scanGroups.size > 0) {
      for (const groupPath of scanGroups) {
        try {
          const result = await client.fetchGroupProjects(groupPath, config.gitlab.include_subgroups);
          projectGroups.push(result);
          totalProjects += result.projects.length;
        } catch (err) {
          hasErrors = true;
          projectGroups.push({ groupPath, groupName: groupPath, projects: [], error: (err as Error).message });
        }
      }
    }

    const projectTableHtml = projectGroups.map((group) => {
      const header = group.projects.length > 0
        ? html`<tr class="group-header"><td colspan="5">
              <strong>${group.groupName}</strong>
              <span class="chip">${group.groupPath}</span>
              <span class="chip">${group.projects.length} projects</span>
            </td></tr>`
        : null;

      const rows = group.projects.map(
        (p) => html`<tr class="${p.archived ? 'muted' : ''}">
          <td class="num">
            <input
              type="checkbox"
              name="project"
              value="${p.fullPath}"
              ${hasProjectOverride ? (scanProjects.has(p.fullPath) ? 'checked' : '') : 'checked'}
              ${hasProjectOverride ? '' : 'disabled'}
            />
          </td>
          <td>${p.name}</td>
          <td><code>${p.fullPath}</code></td>
          <td>
            <span class="chip">${p.visibility}</span>
            ${p.archived ? raw('<span class="chip warn">archived</span>') : ''}
          </td>
          <td class="num">${p.openMergeRequestsCount}</td>
        </tr>`,
      );

      const errorRow = group.error
        ? html`<tr><td colspan="5"><div class="banner error">${group.error}</div></td></tr>`
        : null;

      return raw(html`${header}${rows}${errorRow}`);
    });

    const projectsSection = scanGroups.size === 0
      ? html`<p class="empty">No scan groups selected.</p>`
      : totalProjects === 0 && !hasErrors
        ? html`<p class="empty">No projects found in the selected groups.</p>`
        : raw(html`
            <form method="post" action="/projects/save">
              <p class="hint">
                ${hasProjectOverride
                  ? raw(html`<strong>Only checked projects are scanned.</strong> Uncheck all to scan everything in the selected groups.`)
                  : raw(html`All ${totalProjects} projects are scanned. Check specific projects to switch to whitelist mode.`)}
                ${hasErrors ? raw(' <span class="chip error">Some groups failed to load</span>') : ''}
                ${config.gitlab.include_subgroups ? raw(' <span class="chip">including subgroups</span>') : ''}
              </p>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th class="num">Scan</th>
                      <th>Name</th>
                      <th>Path</th>
                      <th>Status</th>
                      <th class="num">Open MRs</th>
                    </tr>
                  </thead>
                  <tbody>${projectTableHtml}</tbody>
                </table>
              </div>
              <div class="actions">
                <button type="submit">Save project selection</button>
                ${hasProjectOverride
                  ? raw(html`<button type="submit" formaction="/projects/reset-projects" class="secondary" onclick="return confirm('Clear the project whitelist and scan all projects?')">Scan all projects</button>`)
                  : ''}
                ${ctx.provider.hasOverride('gitlab.groups')
                  ? raw(html`<button type="submit" formaction="/projects/reset-groups" class="secondary" onclick="return confirm('Reset scan groups to config.yaml?')">Reset scan groups</button>`)
                  : ''}
              </div>
            </form>`);

    const body = html`
      <div class="card">
        <h2>Scan groups</h2>
        <p class="hint">
          Groups that ReviewNudge queries for merge requests.
          ${ctx.provider.hasOverride('gitlab.groups')
            ? raw(' <span class="chip warn">overridden from config.yaml</span>')
            : ''}
        </p>
        ${raw(groupsHtml)}
      </div>

      <div class="card">
        <h2>Projects</h2>
        ${raw(projectsSection)}
      </div>
    `;

    return render(ctx, request, reply, { title: 'Projects', active: '/projects' }, body);
  });

  app.post('/projects/save', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const groups = formList(body.group);
    const projects = formList(body.project);

    if (groups.length > 0) {
      const before = ctx.provider.resolve().gitlab.groups;
      ctx.repo.setSetting('gitlab.groups', groups);
      ctx.audit.record({
        actor: 'admin',
        sourceIp: sourceIp(request),
        action: 'gitlab.groups.update',
        before,
        after: groups,
      });
    }

    if (projects.length > 0) {
      const before = ctx.provider.resolve().gitlab.projects;
      // If all projects in the page are checked, or projects was set already and now
      // fewer are checked, save the explicit list. If they uncheck everything, we
      // can't distinguish that from "no project checkboxes present" — but the hint
      // text tells them to click "Scan all projects" instead.
      ctx.repo.setSetting('gitlab.projects', projects);
      ctx.audit.record({
        actor: 'admin',
        sourceIp: sourceIp(request),
        action: 'gitlab.projects.update',
        before,
        after: projects,
      });
    }

    return redirectWith(reply, '/projects', { kind: 'ok', message: 'Settings saved.' });
  });

  app.post('/projects/reset-groups', async (request, reply) => {
    ctx.repo.deleteSetting('gitlab.groups');
    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'gitlab.groups.reset',
      target: 'gitlab.groups',
    });
    return redirectWith(reply, '/projects', { kind: 'ok', message: 'Scan groups reset to config.yaml defaults.' });
  });

  app.post('/projects/reset-projects', async (request, reply) => {
    ctx.repo.deleteSetting('gitlab.projects');
    ctx.audit.record({
      actor: 'admin',
      sourceIp: sourceIp(request),
      action: 'gitlab.projects.reset',
      target: 'gitlab.projects',
    });
    return redirectWith(reply, '/projects', { kind: 'ok', message: 'Now scanning all projects in the selected groups.' });
  });
}
