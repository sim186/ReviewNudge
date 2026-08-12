import type { FastifyInstance } from 'fastify';
import { GitLabClient, GitLabError } from '../../gitlab/client.js';
import type { GqlProject } from '../../gitlab/types.js';
import { type AdminContext, render, sourceIp } from '../context.js';
import { html, raw } from '../views/layout.js';

interface GroupProjects {
  groupPath: string;
  groupName: string;
  projects: GqlProject[];
  error?: string;
}

export function registerProjects(app: FastifyInstance, ctx: AdminContext): void {
  app.get('/projects', async (request, reply) => {
    const config = ctx.provider.resolve();
    const groups: GroupProjects[] = [];

    if (config.gitlab.groups.length === 0) {
      return render(
        ctx,
        request,
        reply,
        { title: 'Projects', active: '/projects' },
        html`<div class="card"><h2>Projects</h2><p class="empty">No groups configured in config.yaml.</p></div>`,
      );
    }

    const client = new GitLabClient({
      url: config.gitlab.url,
      token: config.gitlab.token,
      timeoutMs: config.gitlab.timeout_ms,
      pageSize: config.gitlab.page_size,
      logger: ctx.logger,
    });

    let totalProjects = 0;
    let hasErrors = false;

    for (const groupPath of config.gitlab.groups) {
      try {
        const result = await client.fetchGroupProjects(
          groupPath,
          config.gitlab.include_subgroups,
        );
        groups.push(result);
        totalProjects += result.projects.length;
      } catch (err) {
        hasErrors = true;
        const message = err instanceof GitLabError ? err.message : (err as Error).message;
        ctx.logger.warn({ group: groupPath, err: message }, 'failed to fetch group projects');
        groups.push({ groupPath, groupName: groupPath, projects: [], error: message });
      }
    }

    const tableHtml = groups.map((group) => {
      const header =
        group.projects.length > 0
          ? html`<tr class="group-header"><td colspan="4">
                <strong>${group.groupName}</strong>
                <span class="chip">${group.groupPath}</span>
                <span class="chip">${group.projects.length} projects</span>
              </td></tr>`
          : null;

      const rows = group.projects.map(
        (p) => html`<tr class="${p.archived ? 'muted' : ''}">
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
        ? html`<tr><td colspan="4" class="banner error">${group.error}</td></tr>`
        : null;

      return raw(html`${header}${rows}${errorRow}`);
    });

    const body = html`
      <div class="card">
        <h2>Projects</h2>
        <p class="hint">
          ${totalProjects} projects visible to the token across ${groups.length} group${groups.length !== 1 ? 's' : ''}.
          ${hasErrors ? raw('<span class="chip error">Some groups failed to load</span>') : ''}
          ${config.gitlab.include_subgroups ? raw('<span class="chip">including subgroups</span>') : ''}
        </p>
        ${totalProjects > 0
          ? raw(html`<div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Path</th>
                      <th>Status</th>
                      <th class="num">Open MRs</th>
                    </tr>
                  </thead>
                  <tbody>${tableHtml}</tbody>
                </table>
              </div>`)
          : raw(hasErrors
              ? html`<p class="empty">No projects could be loaded. Check the GitLab token and group names.</p>`
              : html`<p class="empty">No projects found in the configured groups.</p>`)}
      </div>
    `;

    return render(ctx, request, reply, { title: 'Projects', active: '/projects' }, body);
  });
}
