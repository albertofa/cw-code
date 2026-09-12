export type DriverKind = "claude" | "opencode" | "codex";

export type SessionStatus = "idle" | "working" | "input-required" | "done" | "resolved" | "archived";

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
}

export interface CreateSessionOptions {
  /** Ref used as the starting point for the new session branch. */
  baseBranch?: string;
  /** Defaults to true for Git repositories. */
  useWorktree?: boolean;
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
}

export type PermissionMode = "auto" | "acceptEdits" | "bypassPermissions" | "manual" | "plan";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

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

export type GitDiffMode = "working" | "staged" | "branch";

export interface GitDiffResult {
  mode: GitDiffMode;
  patch: string;
  baseRef: string | null;
  headRef: string;
}
