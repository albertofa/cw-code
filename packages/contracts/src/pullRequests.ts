import type { GitPullRequestChecks } from "./session.js";

export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

export type PrCiState = "passing" | "failing" | "pending" | "none";

export type PrReviewState = "approved" | "changes_requested" | "review_required" | "none";

export type PrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export type PrBucket = "review" | "action" | "ready" | "waiting" | "merged";

export interface PrSummary {
  ref: PrRef;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: { login: string; isBot: boolean };
  viewerIsAuthor: boolean;
  reviewRequestedFromViewer: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commentsCount: number;
  unresolvedThreads: number;
  ci: PrCiState;
  checks: GitPullRequestChecks;
  review: PrReviewState;
  mergeable: PrMergeable;
  labels: string[];
  /** Epoch milliseconds. */
  updatedAt: number;
}

export interface ProjectGitHubRepo {
  projectId: string;
  host: string;
  owner: string;
  repo: string;
}

export interface PrInboxResult {
  account: { host: string; login: string } | null;
  items: PrSummary[];
  fetchedAt: number;
  error: string | null;
}

export interface PrCheck {
  name: string;
  workflow: string | null;
  status: "success" | "failure" | "pending" | "skipped";
  url: string | null;
  runId: number | null;
  completedAt: number | null;
}

export interface PrCommit {
  oid: string;
  headline: string;
  author: string;
  committedAt: number;
  ci: PrCiState;
}

export interface PrThreadComment {
  author: string;
  body: string;
  createdAt: number;
}

export interface PrReviewThread {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  diffHunk: string;
  comments: PrThreadComment[];
}

export type PrTimelineItem =
  | { kind: "commits"; at: number; actor: string; commits: PrCommit[] }
  | { kind: "review"; at: number; actor: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"; body: string; threadIds: string[] }
  | { kind: "comment"; at: number; actor: string; body: string }
  | { kind: "review_requested"; at: number; actor: string; reviewer: string }
  | { kind: "merged" | "closed" | "reopened" | "ready_for_review"; at: number; actor: string };

export interface PrReviewer {
  login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
}

export interface PrDetail extends PrSummary {
  body: string;
  createdAt: number;
  timeline: PrTimelineItem[];
  threads: PrReviewThread[];
  checkRuns: PrCheck[];
  commits: PrCommit[];
  reviewers: PrReviewer[];
}

export type PrLinkOrigin = "opened" | "workflow" | "linked";

export interface SessionPrLink {
  ref: PrRef;
  origin: PrLinkOrigin;
  workflowId?: string;
  lastSeenSha: string;
  lastSeenAt: number;
}

export type PrUpdateKind = "commits" | "review" | "comment" | "checks_failed" | "checks_passed" | "review_requested";

export interface PrUpdate {
  kind: PrUpdateKind;
  at: number;
  actor: string | null;
  summary: string;
}

export type PrSuggestCondition = "review-requested" | "author" | "checks-failing" | "changes-requested" | "conflicts" | "bot-author" | "draft";

export type PrWorkspaceChoice = "checkout" | "worktree" | "linked";

export type PrWorkflowIcon = "eye" | "activity" | "message" | "wrench" | "merge" | "bot" | "sparkle";

export interface PrWorkflow {
  id: string;
  label: string;
  description: string;
  icon: PrWorkflowIcon;
  builtIn: boolean;
  enabled: boolean;
  suggestWhen: PrSuggestCondition[];
  workspace: PrWorkspaceChoice;
  startPrompt: string;
  updatePrompt: string;
}
