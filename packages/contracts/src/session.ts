import type { AutoFollowUpPause, SessionPrLink } from "./pullRequests.js";
import type { SessionIssueLink, SessionRunLink } from "./github.js";
import type { CommandInvocation } from "./commands.js";

export type DriverKind = "claude" | "opencode" | "codex";

export type SessionStatus = "idle" | "working" | "input-required" | "done" | "holding" | "babysit" | "resolved" | "archived";

export type SessionStatusReason =
  | "session-created"
  | "turn-start"
  | "turn-done"
  | "turn-done-background"
  | "turn-error"
  | "turn-interrupted"
  | "approval-pending"
  | "approval-resolved"
  | "retry-connected"
  | "retry-idle"
  | "resolve"
  | "archive"
  | "restore"
  | "mark-working"
  | "user-set-status"
  | "reopen-on-select"
  | "reopen-on-restore"
  | "turn-seen"
  | "pr-finished"
  | "babysit-ended"
  | "app-restart-holding"
  | "app-restart-idle"
  | "holding-expired"
  | "idle-expired"
  | "turn-start-failed"
  | "unknown";

export type SessionOpenReason = "select" | "restore";

export interface ProjectSettings {
  /** Harness preselected when a new session starts in this project. */
  defaultDriver?: DriverKind;
  /** Model for the default harness. Claude ids may carry the `[1m]` context suffix. */
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  defaultPermissionMode?: PermissionMode;
  /** Shell script run inside a new session worktree right after it is created. */
  setupScript?: string;
  /** Shell script run inside a session worktree right before it is removed. */
  destroyScript?: string;
  /** Extra instructions for the generated session title. */
  titleInstructions?: string;
  /** Instructions for the generated session branch name. When empty, the branch follows the title. */
  branchInstructions?: string;
}

export interface Project {
  id: string;
  rootPath: string;
  name: string;
  /** Optional override. When omitted, cw-code resolves the best authenticated account. */
  githubAccount?: { host: string; login: string };
  settings?: ProjectSettings;
}

export type SubagentIsolation = "shared" | "worktree";

export interface SubagentResult {
  turnId: string;
  outcome: "done" | "error" | "interrupted";
  text: string | null;
  at: number;
}

export interface SubagentLink {
  parentSessionId: string;
  isolation: SubagentIsolation;
  /** Latest settled turn of the child. */
  result?: SubagentResult;
  /** True once the result reached the parent agent, through a tool return or a wake turn. */
  delivered?: boolean;
}

export interface SubagentSummary {
  id: string;
  driver: DriverKind;
  title: string;
  status: SessionStatus;
  model?: string;
  isolation: SubagentIsolation;
  result?: SubagentResult;
  pendingRequests: number;
  createdAt: number;
  updatedAt: number;
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
  /** Permission mode the harness CLI reports running in, which can differ from the requested mode. */
  effectivePermissionMode?: string;
  /** The isolated checkout used by this session. Imported sessions keep the worktree the CLI ran in; older imports omit it. */
  worktreePath?: string;
  /** When the session last entered the idle status. */
  idleSince?: number;
  /** True when the session was resolved by an automatic sweep rather than by the user. */
  autoResolved?: boolean;
  /** Checkout the session ran in when it was resolved or archived, so a restore rebuilds the same one. */
  resolvedCheckout?: ResolvedCheckout;
  /** Last known branch. Live Git status remains the source of truth. */
  branch?: string;
  /** Branch name cw-code generated for this session, so cleanup may delete it like its own `cw/` branches. */
  namedBranch?: string;
  /** Ref the session branch started from; comparison base for ahead/behind and branch diffs. */
  baseRef?: string;
  prs?: SessionPrLink[];
  issues?: SessionIssueLink[];
  runs?: SessionRunLink[];
  /** prKeys of PRs the user explicitly unlinked from this session, so auto-link does not re-attach them. */
  prUnlinked?: string[];
  lastTurnSnapshot?: TurnSnapshot;
  createNotice?: string;
  autoFollowUp?: { paused?: AutoFollowUpPause; turns: number };
  /** Set on hidden child sessions dispatched by another session's agent. */
  subagent?: SubagentLink;
}

export type ResolvedCheckout = { kind: "worktree"; path: string } | { kind: "root" };

export interface TurnSnapshot {
  turnId: string;
  sha?: string;
  capturedAt: number;
  error?: string;
  endSha?: string;
  endedAt?: number;
  endError?: string;
  undoneAt?: number;
}

export type CreateWorkspaceMode = "current" | "new" | "previous";

export interface CreateSessionOptions {
  /** Ref used as the starting point for the new session branch. */
  baseBranch?: string;
  /** When baseBranch is not found on origin or locally, start from the default branch instead of failing. */
  baseFallback?: "default";
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
  /** Skills the prompt mentions as `$name`, in order of first mention. */
  skills?: string[];
  /** Complete spawn environment (process env plus cw-code injections). When omitted, the child inherits the parent env. */
  env?: Record<string, string>;
  /** cw agent MCP endpoint and this session's token, for harnesses whose process is shared across sessions. */
  agent?: { mcpUrl: string; token: string };
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

export interface ComposerChangedEvent {
  sessionId: string;
  prefs: ComposerPrefs;
}

export interface ModelMeta {
  costInputPerM?: number;
  costOutputPerM?: number;
  capabilities?: string[];
  input?: string[];
  output?: string[];
}

export interface ModelOption {
  id: string;
  label: string;
  source: "live" | "curated" | "custom";
  variants?: string[];
  contextWindow?: number;
  meta?: ModelMeta;
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
  headRefOid: string;
  /** Epoch ms of the last update on GitHub; 0 when unknown. */
  updatedAt: number;
  checks: GitPullRequestChecks;
}

export interface GitStatus {
  available: boolean;
  branch: string;
  headSha?: string | null;
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
  /** Failure of the project's destroy script, which ran before the worktree was removed. */
  destroyScriptError?: string;
}

export interface WorktreePruneSummary {
  scanned: number;
  removed: number;
  skipped: number;
  failed: number;
  errors: string[];
  keptDirty: string[];
  clearedSessionIds: string[];
  /** Destroy-script failures for worktrees that were still removed. */
  destroyScriptErrors: string[];
}

export type GitDiffMode = "working" | "staged" | "branch" | "turn";

export interface GitDiffResult {
  mode: GitDiffMode;
  patch: string;
  baseRef: string | null;
  headRef: string;
}

export interface TurnFileChange {
  path: string;
  change: "modified" | "added" | "deleted";
  added: number;
  deleted: number;
  binary: boolean;
}

export interface TurnChanges {
  turnId: string;
  files: TurnFileChange[];
  endSha: string | null;
  undoable: boolean;
  reason?: string;
  conflicts: string[];
}

export interface BranchMismatch {
  sessionBranch: string;
  folderBranch: string;
  folderHead: string;
}

export type GitTopicData = { status: GitStatus | null; error: string | null; mismatch: BranchMismatch | null; branchMismatched: boolean; keptFolderHead: string | null };
