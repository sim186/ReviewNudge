/**
 * GraphQL documents.
 *
 * REST is deliberately not used: GET /projects/:id/merge_requests/:iid/approvals is
 * Premium/Ultimate only, which would cost us the "reviewer has not approved" signal
 * on GitLab Free. The GraphQL equivalents (approvedBy, approved, approvalsLeft,
 * reviewers.mergeRequestInteraction) carry no tier restriction.
 *
 * GitLab scores query complexity at roughly one point per field with a limit of 250
 * for authenticated requests, and caps documents at 10,000 characters — both of which
 * these queries stay well inside regardless of page size.
 */

/**
 * Server features we probe for rather than assume, so the tool keeps working against
 * older self-hosted instances instead of failing the whole run.
 */
export interface Capabilities {
  /** UserMergeRequestInteraction.reviewState — absent before GitLab 17.0. */
  reviewState: boolean;
  /** `commits(last: 1)`, used to find the most recent push. */
  lastCommits: boolean;
}

export const FULL_CAPABILITIES: Capabilities = { reviewState: true, lastCommits: true };

const participantFields = (caps: Capabilities) => `
      username
      name
      bot
      mergeRequestInteraction {
        approved
        reviewed
        ${caps.reviewState ? 'reviewState' : ''}
      }`;

/**
 * One page of open merge requests for a group and, optionally, its subgroups.
 *
 * `notes(last: $notes)` gives recent activity per merge request, which is what the
 * "no activity since the last push" rule compares against. Discussions are not
 * selected here — they are fetched in a second pass only for merge requests whose
 * userDiscussionsCount exceeds resolvedDiscussionsCount.
 */
export function groupMergeRequestsQuery(caps: Capabilities): string {
  return `
query GroupMergeRequests(
  $fullPath: ID!
  $first: Int!
  $after: String
  $includeSubgroups: Boolean!
  $notes: Int!
) {
  group(fullPath: $fullPath) {
    id
    mergeRequests(
      state: opened
      first: $first
      after: $after
      includeSubgroups: $includeSubgroups
      sort: UPDATED_DESC
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        iid
        title
        webUrl
        draft
        createdAt
        updatedAt
        approved
        approvalsLeft
        userNotesCount
        userDiscussionsCount
        resolvedDiscussionsCount
        project { fullPath archived }
        author { username name bot }
        labels { nodes { title } }
        approvedBy { nodes { username } }
        assignees { nodes { ${participantFields(caps)} } }
        reviewers { nodes { ${participantFields(caps)} } }
        ${caps.lastCommits ? 'commits(last: 1) { nodes { committedDate authoredDate } }' : ''}
        notes(last: $notes) {
          nodes { id body createdAt system author { username } }
        }
      }
    }
  }
}`;
}

/** Discussions for a single merge request, fetched only when unresolved ones exist. */
export const MERGE_REQUEST_DISCUSSIONS_QUERY = `
query MergeRequestDiscussions($fullPath: ID!, $iid: String!, $first: Int!, $after: String) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      iid
      discussions(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          resolvable
          resolved
          notes {
            nodes { id body createdAt system author { username } }
          }
        }
      }
    }
  }
}`;

/** Cheap connectivity and token check used by `nudge check-config --remote`. */
export const CURRENT_USER_QUERY = `
query CurrentUser {
  currentUser { username name }
  metadata { version revision }
}`;

/** Projects within a group, optionally including subgroups. */
export function groupProjectsQuery(): string {
  return `
query GroupProjects(
  $fullPath: ID!
  $first: Int!
  $after: String
  $includeSubgroups: Boolean!
) {
  group(fullPath: $fullPath) {
    id
    fullPath
    name
    projects(
      includeSubgroups: $includeSubgroups
      first: $first
      after: $after
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        fullPath
        name
        webUrl
        archived
        visibility
        openMergeRequestsCount
      }
    }
  }
}`;
}
