import type { SessionPrLink } from "./pullRequests.js";
import type { CommandInvocation } from "./commands.js";

export type DriverKind = "claude" | "opencode" | "codex";

export type SessionStatus = "idle" | "working" | "input-required" | "done" | "holding" | "resolved" | "archived";

export interface Project {
  id: string;
  rootPath: string;
  name: string;
  /** Optional override. When omitted, cw-code resolves the best authenticated account. */
  githubAccount?: { host: string; login: string };
}

export interface SessionMeta {
  id: string;
  projectId: string;
  driver: DriverKind;
  title: string;
  status: SessionStatus;
  resumeCursor: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  effort?: EffortLevel;
  variant?: string;
  permissionMode?: PermissionMode;
  /** The isolated checkout used by this session. Older/imported sessions omit it. */
  worktreePath?: string;
  /** Last known branch. Live Git status remains the source of truth. */
  branch?: string;
  prs?: SessionPrLink[];
  /** prKeys of PRs the user explicitly unlinked from this session, so auto-link does not re-attach them. */
  prUnlinked?: string[];
}

export type CreateWorkspaceMode = "current" | "new" | "previous";

export interface CreateSessionOptions {
  /** Ref used as the starting point for the new session branch. */
  baseBranch?: string;
  /** Defaults to true for Git repositories. Ignored when mode is set. */
  useWorktree?: boolean;
  /** Workspace selection for the new session. When omitted, useWorktree decides. */
  mode?: CreateWorkspaceMode;
  /** Worktree to reuse when mode is "previous". Must be an app-managed worktree of the project. */
  reuseWorktreePath?: string;
  /** Start the worktree from a pull request head instead of baseBranch. */
  prHead?: { number: number; headRefName: string; headRefOid: string; viewerIsAuthor: boolean };
}

export interface TurnRequest {
  sessionId: string;
  cwd: string;
  prompt: string;
  resumeCursor?: string;
  model?: string;
  effort?: EffortLevel;
  variant?: string;
  permissionMode?: PermissionMode;
  attachments?: string[];
  allowedTools?: string[];
  maxTurns?: number;
  command?: CommandInvocation;
  /** Complete spawn environment (process env plus cw-code injections). When omitted, the child inherits the parent env. */
  env?: Record<string, string>;
}

export type PermissionMode = "auto" | "acceptEdits" | "bypassPermissions" | "manual";

export interface PermissionOption {
  id: PermissionMode;
  label: string;
  description: string;
  /** False when cw-code synthesizes the mode via background auto-accept. */
  native: boolean;
}

export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ComposerPrefs {
  model?: string;
  effort?: EffortLevel;
  variant?: string;
  permissionMode?: PermissionMode;
}

export interface ModelOption {
  id: string;
  label: string;
  source: "live" | "curated" | "custom";
  variants?: string[];
  contextWindow?: number;
}

export interface GitPullRequestChecks {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface GitPullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  headRefName: string;
  baseRefName: string;
  checks: GitPullRequestChecks;
}

export interface GitStatus {
  available: boolean;
  branch: string;
  dirtyCount: number;
  addedLines: number;
  deletedLines: number;
  stagedCount: number;
  ahead: number;
  behind: number;
  /** Reference branch used for branch comparison (e.g. main). Null when none is available. */
  baseRef: string | null;
  /** Commits on HEAD not reachable from baseRef. */
  baseAhead: number;
  /** Commits on baseRef not reachable from HEAD. */
  baseBehind: number;
  isWorktree: boolean;
  worktreeName: string;
  worktreePath: string;
  repositoryRoot: string;
  prNumber: number | null;
  pullRequest: GitPullRequest | null;
  githubError: string | null;
  githubHost: string | null;
  githubAccount: string | null;
  githubAccountSource: GitHubAccountSelectionSource;
  clean: boolean;
}

export type GitHubAccountSelectionSource = "project" | "owner" | "access" | "single" | "active" | "none";

export interface GitHubAccountInfo {
  host: string;
  login: string;
  active: boolean;
  authenticated: boolean;
  hasRepositoryAccess: boolean | null;
}

export interface SourceControlBinaryHealth {
  path: string;
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface SourceControlHealth {
  git: SourceControlBinaryHealth;
  githubCli: SourceControlBinaryHealth;
  repository: {
    available: boolean;
    root: string | null;
    branch: string | null;
    remoteUrl: string | null;
    githubHost: string | null;
    githubRepository: string | null;
    userName: string | null;
    userEmail: string | null;
    error: string | null;
  };
  github: {
    accounts: GitHubAccountInfo[];
    selectedAccount: string | null;
    selectionSource: GitHubAccountSelectionSource;
    error: string | null;
  };
  issues: Array<{ level: "error" | "warning"; message: string }>;
}

export interface GitBranchInfo {
  name: string;
  label: string;
  current: boolean;
  remote: boolean;
  worktreePath: string | null;
}

export interface SessionCleanupResult {
  sessionId: string;
  status: SessionStatus;
  worktreePath?: string;
  worktreeOrphaned: boolean;
  worktreeRemoved: boolean;
  dirtyBlocked?: boolean;
  branchDeleted: boolean;
  unmergedCommits?: boolean;
  /** Commits on the session branch that no other branch reaches. Present after an orphan check. */
  unmergedCommitCount?: number;
  error?: string;
}

export interface WorktreePruneSummary {
  scanned: number;
  removed: number;
  skipped: number;
  failed: number;
  errors: string[];
  keptDirty: string[];
  clearedSessionIds: string[];
}

export type GitDiffMode = "working" | "staged" | "branch";

export interface GitDiffResult {
  mode: GitDiffMode;
  patch: string;
  baseRef: string | null;
  headRef: string;
}
