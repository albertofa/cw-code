import type { GitHubAccountRef, PrSummary, RepoRef, WorkflowRunSummary } from "@cw-code/contracts";

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

export interface PrInboxResult {
  account: { host: string; login: string } | null;
  items: PrSummary[];
  fetchedAt: number;
  error: string | null;
  truncated?: boolean;
  limit?: number;
}
