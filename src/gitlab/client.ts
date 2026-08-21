import { logger as rootLogger, type Logger } from '../logger.js';
import { USER_AGENT } from '../version.js';
import {
  CURRENT_USER_QUERY,
  DEFAULT_QUERY_OPTIONS,
  FULL_CAPABILITIES,
  MERGE_REQUEST_DISCUSSIONS_QUERY,
  USER_EMAILS_QUERY,
  ACCESSIBLE_GROUPS_QUERY,
  groupMergeRequestsQuery,
  groupProjectsQuery,
  type Capabilities,
  type QueryOptions,
} from './queries.js';
import type {
  AccessibleGroupsResponse,
  EnrichedMergeRequest,
  GqlDiscussion,
  GqlGroup,
  GqlMergeRequest,
  GqlProject,
  GroupMergeRequestsResponse,
  GroupProjectsResponse,
  MergeRequestDiscussionsResponse,
  PageInfo,
} from './types.js';

export class GitLabError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly graphqlErrors?: GraphQLError[],
  ) {
    super(message);
    this.name = 'GitLabError';
  }
}

interface GraphQLError {
  message: string;
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLError[];
}

export interface GitLabClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  pageSize?: number;
  maxRetries?: number;
  /** Notes fetched per merge request for the activity-since-push comparison. */
  notesPerMr?: number;
  /** Ask for the merge request description, which only the ticket warning reads. */
  includeDescription?: boolean;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter backoff, so concurrent instances do not retry in lockstep. */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.round(Math.random() * base);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** Detects the "this server is too old for that field" class of GraphQL error. */
function mentionsUnknownField(errors: GraphQLError[], needle: string): boolean {
  return errors.some(
    (e) =>
      e.message.includes(needle) &&
      /doesn't exist|does not exist|undefined field|invalid value|Field '.*' doesn't|no field/i.test(
        e.message,
      ),
  );
}

export class GitLabClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly maxRetries: number;
  private readonly notesPerMr: number;
  private readonly log: Logger;
  private readonly doFetch: typeof fetch;

  private capabilities: Capabilities = { ...FULL_CAPABILITIES };
  private readonly queryOptions: QueryOptions;

  constructor(private readonly options: GitLabClientOptions) {
    this.endpoint = new URL('/api/graphql', options.url).toString();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pageSize = Math.min(options.pageSize ?? 50, 100);
    this.maxRetries = options.maxRetries ?? 4;
    this.notesPerMr = options.notesPerMr ?? 30;
    this.queryOptions = {
      includeDescription: options.includeDescription ?? DEFAULT_QUERY_OPTIONS.includeDescription,
    };
    this.log = options.logger ?? rootLogger;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  get currentCapabilities(): Readonly<Capabilities> {
    return this.capabilities;
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt - 1));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      try {
        response = await this.doFetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.token}`,
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
      } catch (err) {
        // Network failure or timeout: worth another attempt.
        lastError = err as Error;
        this.log.warn(
          { attempt, err: lastError.message },
          'GitLab request failed, retrying',
        );
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 401 || response.status === 403) {
        throw new GitLabError(
          `GitLab rejected the token (HTTP ${response.status}). Check gitlab.token and that it has the read_api scope.`,
          response.status,
        );
      }

      if (RETRYABLE_STATUS.has(response.status)) {
        const wait = parseRetryAfter(response.headers.get('retry-after'));
        lastError = new GitLabError(`GitLab returned HTTP ${response.status}`, response.status);
        this.log.warn({ attempt, status: response.status, wait }, 'GitLab throttled or erroring');
        if (wait !== null) await sleep(wait);
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new GitLabError(
          `GitLab returned HTTP ${response.status}: ${body.slice(0, 500)}`,
          response.status,
        );
      }

      const payload = (await response.json()) as GraphQLResponse<T>;
      if (payload.errors?.length) {
        throw new GitLabError(
          `GitLab GraphQL error: ${payload.errors.map((e) => e.message).join('; ')}`,
          response.status,
          payload.errors,
        );
      }
      if (!payload.data) {
        throw new GitLabError('GitLab returned an empty GraphQL response');
      }
      return payload.data;
    }

    throw new GitLabError(
      `GitLab request failed after ${this.maxRetries + 1} attempts: ${lastError?.message ?? 'unknown error'}`,
    );
  }

  /** Verifies connectivity and the token, returning the instance version. */
  async checkConnection(): Promise<{ username: string | null; version: string | null }> {
    const data = await this.request<{
      currentUser: { username: string } | null;
      metadata: { version: string } | null;
    }>(CURRENT_USER_QUERY, {});
    return {
      username: data.currentUser?.username ?? null,
      version: data.metadata?.version ?? null,
    };
  }

  /**
   * Every open merge request in a group, following cursors to the end.
   *
   * When the server rejects a field this build asks for, the capability is switched
   * off and the page is retried — an old instance degrades to fewer signals rather
   * than failing the run outright.
   */
  async fetchGroupMergeRequests(
    fullPath: string,
    includeSubgroups: boolean,
  ): Promise<GqlMergeRequest[]> {
    const collected: GqlMergeRequest[] = [];
    let after: string | null = null;

    for (;;) {
      const variables = {
        fullPath,
        first: this.pageSize,
        after,
        includeSubgroups,
        notes: this.notesPerMr,
      };

      let data: GroupMergeRequestsResponse;
      try {
        data = await this.request<GroupMergeRequestsResponse>(
          groupMergeRequestsQuery(this.capabilities, this.queryOptions),
          variables,
        );
      } catch (err) {
        if (err instanceof GitLabError && err.graphqlErrors && this.downgrade(err.graphqlErrors)) {
          continue; // retry the same cursor with a reduced query
        }
        throw err;
      }

      if (!data.group) {
        throw new GitLabError(
          `group "${fullPath}" was not found, or the token cannot see it. Check gitlab.groups.`,
        );
      }

      collected.push(...data.group.mergeRequests.nodes);
      const page = data.group.mergeRequests.pageInfo;
      if (!page.hasNextPage || !page.endCursor) break;
      after = page.endCursor;
    }

    this.log.debug({ group: fullPath, count: collected.length }, 'fetched group merge requests');
    return collected;
  }

  /** All projects within a group and optionally its subgroups, following cursors. */
  async fetchGroupProjects(
    fullPath: string,
    includeSubgroups: boolean,
  ): Promise<{ groupPath: string; groupName: string; projects: GqlProject[] }> {
    const collected: GqlProject[] = [];
    let after: string | null = null;
    let groupPath = '';
    let groupName = '';

    for (;;) {
      const variables: Record<string, unknown> = {
        fullPath,
        first: this.pageSize,
        after,
        includeSubgroups,
      };

      const data: GroupProjectsResponse = await this.request<GroupProjectsResponse>(
        groupProjectsQuery(),
        variables,
      );

      if (!data.group) {
        throw new GitLabError(
          `group "${fullPath}" was not found, or the token cannot see it. Check gitlab.groups.`,
        );
      }

      groupPath = data.group.fullPath;
      groupName = data.group.name;
      collected.push(...data.group.projects.nodes);
      const page: PageInfo = data.group.projects.pageInfo;
      if (!page.hasNextPage || !page.endCursor) break;
      after = page.endCursor;
    }

    this.log.debug(
      { group: fullPath, count: collected.length },
      'fetched group projects',
    );
    return { groupPath, groupName, projects: collected };
  }

  /** Every group the token can see, following cursors. */
  async fetchAccessibleGroups(): Promise<GqlGroup[]> {
    const collected: GqlGroup[] = [];
    let after: string | null = null;

    for (;;) {
      const variables: Record<string, unknown> = { first: this.pageSize, after };
      const data: AccessibleGroupsResponse = await this.request<AccessibleGroupsResponse>(
        ACCESSIBLE_GROUPS_QUERY,
        variables,
      );

      collected.push(...data.groups.nodes);
      if (!data.groups.pageInfo.hasNextPage || !data.groups.pageInfo.endCursor) break;
      after = data.groups.pageInfo.endCursor;
    }

    this.log.debug({ count: collected.length }, 'fetched accessible groups');
    return collected;
  }

  /**
   * Public email addresses for a set of usernames.
   *
   * A failed or partial lookup degrades to whatever was collected rather than sinking
   * the run — names that come back without an address simply fall through to the
   * derived-domain fallback in the digest builder.
   */
  async fetchUserEmails(usernames: readonly string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(usernames)].sort();
    const out = new Map<string, string | null>();
    const chunkSize = this.pageSize;

    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      try {
        const data = await this.request<{
          users: { nodes: { username: string; publicEmail: string | null }[] } | null;
        }>(USER_EMAILS_QUERY, { usernames: chunk });
        for (const node of data.users?.nodes ?? []) out.set(node.username, node.publicEmail);
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'could not look up user emails');
        return out;
      }
    }

    return out;
  }

  /** Turns a capability-related GraphQL error into a reduced query. */
  private downgrade(errors: GraphQLError[]): boolean {
    if (this.capabilities.reviewState && mentionsUnknownField(errors, 'reviewState')) {
      this.capabilities.reviewState = false;
      this.log.warn(
        'this GitLab does not expose reviewState (pre-17.0); falling back to approvedBy membership',
      );
      return true;
    }
    if (this.capabilities.lastCommits && mentionsUnknownField(errors, 'commits')) {
      this.capabilities.lastCommits = false;
      this.log.warn(
        'this GitLab rejected commits(last: 1); using updatedAt as the last-push timestamp',
      );
      return true;
    }
    return false;
  }

  /** All discussions for one merge request, following cursors. */
  async fetchDiscussions(projectPath: string, iid: string): Promise<GqlDiscussion[]> {
    const collected: GqlDiscussion[] = [];
    let after: string | null = null;

    for (;;) {
      const data: MergeRequestDiscussionsResponse =
        await this.request<MergeRequestDiscussionsResponse>(MERGE_REQUEST_DISCUSSIONS_QUERY, {
          fullPath: projectPath,
          iid,
          first: 50,
          after,
        });

      const mr = data.project?.mergeRequest;
      if (!mr) break;

      collected.push(...mr.discussions.nodes);
      if (!mr.discussions.pageInfo.hasNextPage || !mr.discussions.pageInfo.endCursor) break;
      after = mr.discussions.pageInfo.endCursor;
    }

    return collected;
  }

  /**
   * Attaches discussions to the merge requests that have unresolved ones.
   *
   * The counts come free with the group query, so most merge requests never trigger a
   * second request. `shouldEnrich` lets the caller skip merge requests already
   * excluded by filters, which is why filtering runs before enrichment.
   */
  async enrich(
    mrs: GqlMergeRequest[],
    shouldEnrich: (mr: GqlMergeRequest) => boolean,
  ): Promise<EnrichedMergeRequest[]> {
    const out: EnrichedMergeRequest[] = [];

    for (const mr of mrs) {
      const projectPath = mr.project?.fullPath ?? '';
      const unresolved =
        (mr.userDiscussionsCount ?? 0) - (mr.resolvedDiscussionsCount ?? 0) > 0;

      let discussions: GqlDiscussion[] = [];
      if (unresolved && projectPath && shouldEnrich(mr)) {
        try {
          discussions = await this.fetchDiscussions(projectPath, mr.iid);
        } catch (err) {
          // A single unreadable merge request must not sink the run; it simply loses
          // its thread-based reasons.
          this.log.warn(
            { mr: mr.webUrl, err: (err as Error).message },
            'could not fetch discussions',
          );
        }
      }

      out.push({ ...mr, projectPath, discussions: { nodes: discussions } });
    }

    return out;
  }
}
