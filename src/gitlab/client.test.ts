import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { GitLabClient, GitLabError } from './client.js';
import type { GqlMergeRequest } from './types.js';

const silent = pino({ level: 'silent' });

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function mr(iid: string, overrides: Partial<GqlMergeRequest> = {}): GqlMergeRequest {
  return {
    id: `gid://gitlab/MergeRequest/${iid}`,
    iid,
    title: `MR ${iid}`,
    webUrl: `https://gitlab.example.com/a/b/-/merge_requests/${iid}`,
    draft: false,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    approved: false,
    approvalsLeft: 1,
    userDiscussionsCount: 0,
    resolvedDiscussionsCount: 0,
    project: { fullPath: 'a/b', archived: false },
    author: { username: 'bob', name: 'Bob' },
    labels: { nodes: [] },
    approvedBy: { nodes: [] },
    assignees: { nodes: [] },
    reviewers: { nodes: [] },
    commits: { nodes: [] },
    notes: { nodes: [] },
    ...overrides,
  };
}

function groupPage(nodes: GqlMergeRequest[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: { group: { id: 'gid://gitlab/Group/1', mergeRequests: { pageInfo: { hasNextPage, endCursor }, nodes } } },
  };
}

function client(fetchImpl: typeof fetch, opts = {}) {
  return new GitLabClient({
    url: 'https://gitlab.example.com',
    token: 'glpat-test',
    logger: silent,
    maxRetries: 2,
    ...opts,
    fetchImpl,
  });
}

describe('GitLabClient', () => {
  it('posts to /api/graphql with a bearer token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupPage([mr('1')])));
    await client(fetchImpl as unknown as typeof fetch).fetchGroupMergeRequests('eng', true);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gitlab.example.com/api/graphql');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer glpat-test');
    expect(JSON.parse(init.body as string).variables).toMatchObject({
      fullPath: 'eng',
      includeSubgroups: true,
    });
  });

  it('follows cursors until the last page', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(groupPage([mr('1')], true, 'cursor-1')))
      .mockResolvedValueOnce(jsonResponse(groupPage([mr('2')], false)));

    const out = await client(fetchImpl as unknown as typeof fetch).fetchGroupMergeRequests('eng', true);
    expect(out.map((m) => m.iid)).toEqual(['1', '2']);

    const second = JSON.parse((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(second.variables.after).toBe('cursor-1');
  });

  it('retries a 429 and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(groupPage([mr('1')])));

    const out = await client(fetchImpl as unknown as typeof fetch).fetchGroupMergeRequests('eng', true);
    expect(out).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a network error and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(groupPage([mr('1')])));

    const out = await client(fetchImpl as unknown as typeof fetch).fetchGroupMergeRequests('eng', true);
    expect(out).toHaveLength(1);
  });

  it('gives up after the retry budget and reports the last error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    await expect(
      client(fetchImpl as unknown as typeof fetch).fetchGroupMergeRequests('eng', true),
    ).rejects.toThrow(/after 3 attempts/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry an auth failure and explains the token scope', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    await expect(
      client(fetchImpl as unknown as typeof fetch).fetchGroupMergeRequests('eng', true),
    ).rejects.toThrow(/read_api scope/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a missing or invisible group clearly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { group: null } }));
    await expect(
      client(fetchImpl as unknown as typeof fetch).fetchGroupMergeRequests('nope', true),
    ).rejects.toThrow(/group "nope" was not found/);
  });

  it('drops reviewState and retries when the server is too old for it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          errors: [{ message: "Field 'reviewState' doesn't exist on type 'UserMergeRequestInteraction'" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(groupPage([mr('1')])));

    const c = client(fetchImpl as unknown as typeof fetch);
    const out = await c.fetchGroupMergeRequests('eng', true);

    expect(out).toHaveLength(1);
    expect(c.currentCapabilities.reviewState).toBe(false);
    expect((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body).not.toContain('reviewState');
  });

  it('drops commits(last:) when the server rejects it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: "Argument 'last' on Field 'commits' has an invalid value" }] }),
      )
      .mockResolvedValueOnce(jsonResponse(groupPage([mr('1')])));

    const c = client(fetchImpl as unknown as typeof fetch);
    await c.fetchGroupMergeRequests('eng', true);
    expect(c.currentCapabilities.lastCommits).toBe(false);
    expect((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body).not.toContain('commits(last');
  });

  it('surfaces a non-capability GraphQL error instead of looping', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors: [{ message: 'Query has complexity of 300, which exceeds max complexity of 250' }] }));

    await expect(
      client(fetchImpl as unknown as typeof fetch).fetchGroupMergeRequests('eng', true),
    ).rejects.toThrow(GitLabError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps the page size at the GitLab maximum of 100', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupPage([])));
    await client(fetchImpl as unknown as typeof fetch, { pageSize: 500 }).fetchGroupMergeRequests('eng', true);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.variables.first).toBe(100);
  });

  it('leaves descriptions out of the query unless a rule needs them', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupPage([])));
    await client(fetchImpl as unknown as typeof fetch).fetchGroupMergeRequests('eng', true);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.query).not.toMatch(/^\s*description$/m);
  });

  it('asks for descriptions when told to', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupPage([])));
    await client(fetchImpl as unknown as typeof fetch, {
      includeDescription: true,
    }).fetchGroupMergeRequests('eng', true);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.query).toMatch(/^\s*description$/m);
  });
});

describe('GitLabClient.enrich', () => {
  it('only fetches discussions when unresolved threads exist', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          project: {
            mergeRequest: {
              iid: '2',
              discussions: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: 'd1', resolvable: true, resolved: false, notes: { nodes: [] } }],
              },
            },
          },
        },
      }),
    );

    const clean = mr('1', { userDiscussionsCount: 3, resolvedDiscussionsCount: 3 });
    const dirty = mr('2', { userDiscussionsCount: 3, resolvedDiscussionsCount: 1 });

    const out = await client(fetchImpl as unknown as typeof fetch).enrich([clean, dirty], () => true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out[0]?.discussions.nodes).toHaveLength(0);
    expect(out[1]?.discussions.nodes).toHaveLength(1);
    expect(out[1]?.projectPath).toBe('a/b');
  });

  it('skips merge requests the caller has already filtered out', async () => {
    const fetchImpl = vi.fn();
    const dirty = mr('2', { userDiscussionsCount: 3, resolvedDiscussionsCount: 1 });
    await client(fetchImpl as unknown as typeof fetch).enrich([dirty], () => false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the merge request when its discussions cannot be read', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const dirty = mr('2', { userDiscussionsCount: 3, resolvedDiscussionsCount: 1 });

    const out = await client(fetchImpl as unknown as typeof fetch).enrich([dirty], () => true);
    expect(out).toHaveLength(1);
    expect(out[0]?.discussions.nodes).toEqual([]);
  });
});
