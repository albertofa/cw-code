import type { PrLinkOrigin, PrRef } from "./pullRequests.js";

export interface RepoRef {
  host: string;
  owner: string;
  repo: string;
}

export interface IssueRef extends RepoRef {
  number: number;
}

export interface RunRef extends RepoRef {
  runId: number;
}

export type GitHubKind = "pr" | "issue" | "run";

export type GitHubViewGroup = "triage" | "repo" | "none";

export interface SavedGitHubView {
  id: string;
  kind: GitHubKind;
  name: string;
  query: string;
  group: GitHubViewGroup;
}

export interface GitHubAccountRef {
  host: string;
  login: string;
}

export interface GitHubSearchResult<T> {
  account: GitHubAccountRef | null;
  items: T[];
  openCount: number | null;
  closedCount: number | null;
  truncated: boolean;
  limit: number;
  fetchedAt: number;
  error: string | null;
}

export interface IssueLinkedPr {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
}

export interface IssueSummary {
  ref: IssueRef;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED";
  stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null;
  author: { login: string; isBot: boolean };
  assignees: string[];
  labels: string[];
  milestone: string | null;
  commentsCount: number;
  linkedPrs: IssueLinkedPr[];
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
}

export interface IssueComment {
  author: string;
  body: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface IssueDetail extends IssueSummary {
  body: string;
  comments: IssueComment[];
  viewerLogin: string;
}

export type RunStatus = "queued" | "in_progress" | "completed";

export type RunConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "neutral"
  | "timed_out"
  | "action_required"
  | "stale"
  | "startup_failure"
  | null;

export interface RunJob {
  name: string;
  status: RunStatus;
  conclusion: RunConclusion;
  startedAt: number | null;
  completedAt: number | null;
  url: string | null;
}

export interface WorkflowRunSummary {
  ref: RunRef;
  url: string;
  workflowName: string;
  runNumber: number;
  event: string;
  branch: string | null;
  headSha: string;
  title: string;
  actor: string | null;
  status: RunStatus;
  conclusion: RunConclusion;
  prNumber: number | null;
  onDefaultBranch: boolean;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
  jobs: RunJob[];
}

export interface RunSources {
  prSearchQuery: string | null;
  repos: RepoRef[];
  orgs: string[];
}

export interface RunsResult {
  account: GitHubAccountRef | null;
  items: WorkflowRunSummary[];
  fetchedAt: number;
  error: string | null;
}

export interface SessionIssueLink {
  ref: IssueRef;
  origin: PrLinkOrigin;
  workflowId?: string;
  lastSeenAt: number;
}

export interface SessionRunLink {
  ref: RunRef;
  origin: PrLinkOrigin;
  workflowId?: string;
  lastSeenAt: number;
}

export type WorkflowSubject =
  | { kind: "pr"; ref: PrRef }
  | { kind: "issue"; ref: IssueRef }
  | { kind: "run"; ref: RunRef };
