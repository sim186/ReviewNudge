/**
 * Narrowed shapes of the GraphQL responses we ask for. These mirror the selection
 * sets in queries.ts rather than GitLab's full schema.
 */

/** MergeRequestReviewState, as published in the GitLab GraphQL reference. */
export type ReviewState =
  | 'UNREVIEWED'
  | 'REVIEW_STARTED'
  | 'REVIEWED'
  | 'REQUESTED_CHANGES'
  | 'APPROVED'
  | 'UNAPPROVED';

export interface GqlUser {
  username: string;
  name: string | null;
  bot?: boolean | null;
  webUrl?: string | null;
}

export interface GqlParticipant extends GqlUser {
  mergeRequestInteraction: {
    approved: boolean;
    reviewed: boolean;
    reviewState: ReviewState | null;
  } | null;
}

export interface GqlNote {
  id: string;
  body: string;
  createdAt: string;
  system: boolean;
  author: GqlUser | null;
}

export interface GqlDiscussion {
  id: string;
  resolvable: boolean;
  resolved: boolean;
  notes: { nodes: GqlNote[] };
}

export interface GqlMergeRequest {
  id: string;
  iid: string;
  title: string;
  /** Only selected when a rule needs it; see QueryOptions.includeDescription. */
  description?: string | null;
  webUrl: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  approved: boolean;
  approvalsLeft: number | null;
  userNotesCount: number | null;
  userDiscussionsCount: number | null;
  resolvedDiscussionsCount: number | null;
  project: { fullPath: string; archived: boolean } | null;
  author: GqlUser | null;
  labels: { nodes: { title: string }[] } | null;
  approvedBy: { nodes: GqlUser[] } | null;
  assignees: { nodes: GqlParticipant[] } | null;
  reviewers: { nodes: GqlParticipant[] } | null;
  commits: { nodes: { committedDate: string | null; authoredDate: string | null }[] } | null;
  notes?: { nodes: GqlNote[] } | null;
  discussions?: { nodes: GqlDiscussion[] } | null;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GroupMergeRequestsResponse {
  group: {
    id: string;
    mergeRequests: { pageInfo: PageInfo; nodes: GqlMergeRequest[] };
  } | null;
}

export interface MergeRequestDiscussionsResponse {
  project: {
    mergeRequest: {
      iid: string;
      discussions: { pageInfo: PageInfo; nodes: GqlDiscussion[] };
    } | null;
  } | null;
}

/** A merge request with its discussions resolved, ready for the rule engine. */
export interface EnrichedMergeRequest extends GqlMergeRequest {
  projectPath: string;
  discussions: { nodes: GqlDiscussion[] };
}

export interface GqlProject {
  id: string;
  fullPath: string;
  name: string;
  webUrl: string;
  archived: boolean;
  visibility: string;
  openMergeRequestsCount: number;
}

export interface GroupProjectsResponse {
  group: {
    id: string;
    fullPath: string;
    name: string;
    projects: { pageInfo: PageInfo; nodes: GqlProject[] };
  } | null;
}

export interface GqlGroup {
  id: string;
  fullPath: string;
  name: string;
  description: string | null;
  webUrl: string;
  parent: { id: string; fullPath: string } | null;
}

export interface AccessibleGroupsResponse {
  groups: { pageInfo: PageInfo; nodes: GqlGroup[] };
}
