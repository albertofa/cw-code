import type {
  AccountUsageOk,
  AccountUsageSnapshot,
  AccountUsageState,
  AccountUsageUnavailableReason,
  CliBinary,
  CliDiscoveredCandidate,
  CliDiscoverResult,
  CommandInvocation,
  CommandOption,
  ContextUsage,
  HarnessId,
  PrBucket,
  PrCheck,
  PrCiState,
  PrCommit,
  PrDetail,
  PrInboxResult,
  ProjectGitHubRepo,
  PrLinkOrigin,
  PrMergeable,
  PrRef,
  PrReviewer,
  PrReviewState,
  PrReviewThread,
  PrSummary,
  PrThreadComment,
  PrTimelineItem,
  PrWorkflow,
  SessionPrLink,
  SkillDetail,
  SkillMeta,
  SkillSaveInput,
  SkillsListResult,
  TokenCounts,
  TurnModelUsage,
  UsageBalance,
  UsageLedgerQuery,
  UsageLedgerRow,
  UsageSeverity,
  UsageWindow
} from "@cw-code/contracts";

export type {
  AccountUsageOk,
  AccountUsageSnapshot,
  AccountUsageState,
  AccountUsageUnavailableReason,
  ContextUsage,
  PrBucket,
  PrCheck,
  PrCiState,
  PrCommit,
  PrDetail,
  PrInboxResult,
  ProjectGitHubRepo,
  PrLinkOrigin,
  PrMergeable,
  PrRef,
  PrReviewer,
  PrReviewState,
  PrReviewThread,
  PrSummary,
  PrThreadComment,
  PrTimelineItem,
  PrWorkflow,
  SessionPrLink,
  TokenCounts,
  TurnModelUsage,
  UsageBalance,
  UsageLedgerQuery,
  UsageLedgerRow,
  UsageSeverity,
  UsageWindow
};

export interface Project {
  id: string;
  rootPath: string;
  name: string;
  githubAccount?: { host: string; login: string };
}

export type DriverName = "claude" | "opencode" | "codex";

export type SessionStatus = "idle" | "working" | "input-required" | "done" | "holding" | "resolved" | "archived";

export interface Session {
  id: string;
  projectId: string;
  driver: DriverName;
  title: string;
  status: SessionStatus;
  resumeCursor: string;
  createdAt: number;
  updatedAt: number;
  worktreePath?: string;
  branch?: string;
  prs?: SessionPrLink[];
  prUnlinked?: string[];
}

export type CreateWorkspaceMode = "current" | "new" | "previous";

export interface CreateSessionOptions {
  baseBranch?: string;
  useWorktree?: boolean;
  mode?: CreateWorkspaceMode;
  reuseWorktreePath?: string;
  prHead?: { number: number; headRefName: string; headRefOid: string; viewerIsAuthor: boolean };
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

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
}

export interface ToolUsage {
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "reasoning";
  text: string;
  turnId: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  subagentModel?: string;
  subagentTools?: SubagentToolSummary;
  subagentAgentId?: string;
  parentToolCallId?: string;
  toolUsage?: ToolUsage;
  todos?: TodoItem[];
  reasoningMs?: number;
}

export interface SubagentToolActivity {
  id: string;
  name: string;
  input: unknown;
  timestamp?: number;
  completedAt?: number;
  output?: string;
  isError?: boolean;
}

export interface SubagentToolSummary {
  total: number;
  items: SubagentToolActivity[];
  effort?: string;
  totalTokens?: number;
}

export interface SubagentToolsResult {
  items: SubagentToolActivity[];
  model?: string;
  effort?: string;
  tokens?: number;
}

export interface RetryConnectionResult {
  status: "running" | "done";
  turnId?: string;
  history: HistoryMessage[];
}

export interface ActiveTurn {
  sessionId: string;
  turnId: string;
  startedAt: number;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "acceptGlobal" | "decline" | "cancel";

export type ApprovalKind = "command" | "fileChange" | "permissions";

export interface ApprovalRequest {
  requestId: string;
  kind: ApprovalKind;
  title: string;
  reason?: string;
  details?: string;
  decisions: ApprovalDecision[];
  permission?: string;
  patterns?: string[];
  always?: string[];
  toolName?: string;
  cwd?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowCustom: boolean;
}

export interface QuestionRequest {
  requestId: string;
  turnId: string;
  questions: QuestionInfo[];
}

export type TurnEvent =
  | { type: "assistant.delta"; turnId: string; text: string }
  | { type: "reasoning.delta"; turnId: string; text: string }
  | {
      type: "tool.call";
      turnId: string;
      toolCallId: string;
      name: string;
      input: unknown;
      parentToolCallId?: string;
      model?: string;
    }
  | {
      type: "tool.result";
      turnId: string;
      toolCallId: string;
      output: string;
      isError: boolean;
      usage?: ToolUsage;
      agentId?: string;
      model?: string;
    }
  | { type: "approval.request"; turnId: string; request: ApprovalRequest }
  | { type: "approval.resolved"; turnId: string; requestId: string }
  | { type: "question.request"; turnId: string; request: QuestionRequest }
  | {
      type: "question.resolved";
      turnId: string;
      requestId: string;
      answers: Record<string, string> | null;
    }
  | { type: "todo.updated"; turnId: string; todos: TodoItem[] }
  | {
      type: "turn.done";
      turnId: string;
      sessionId: string;
      resumeCursor: string;
      resultText: string;
      usage: TurnModelUsage[];
      context?: ContextUsage;
      numTurns: number;
      isError: boolean;
      backgroundTasks: number;
    }
  | { type: "turn.error"; turnId: string; message: string; resumeCursor?: string; retryable?: boolean }
  | {
      type: "turn.retry";
      turnId: string;
      attempt: number;
      message: string;
      detail?: string;
      retryAt: number;
      link?: string;
    }
  | { type: "session.branch.updated"; turnId: string; sessionId: string; branch: string };

export type PermissionMode = "auto" | "acceptEdits" | "bypassPermissions" | "manual";

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

export interface PermissionOption {
  id: PermissionMode;
  label: string;
  description: string;
  native: boolean;
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
  baseRef: string | null;
  baseAhead: number;
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

export interface SourceControlHealth {
  git: { path: string; available: boolean; version: string | null; error: string | null };
  githubCli: { path: string; available: boolean; version: string | null; error: string | null };
  repository: {
    available: boolean; root: string | null; branch: string | null; remoteUrl: string | null;
    githubHost: string | null; githubRepository: string | null; userName: string | null;
    userEmail: string | null; error: string | null;
  };
  github: {
    accounts: GitHubAccountInfo[]; selectedAccount: string | null;
    selectionSource: GitHubAccountSelectionSource; error: string | null;
  };
  issues: Array<{ level: "error" | "warning"; message: string }>;
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
  checks: { total: number; passed: number; failed: number; pending: number };
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

export interface CustomModel {
  id: string;
  name: string;
}

export interface AppSettings {
  claudeBinaryPath: string;
  opencodeBinaryPath: string;
  codexBinaryPath: string;
  claudeExtraArgs: string;
  opencodeExtraArgs: string;
  codexExtraArgs: string;
  claudeDefaultModel: string;
  claudeEnabledModels: string[];
  claudeCustomModel: CustomModel;
  claudeReasoningExpanded: boolean;
  opencodeReasoningExpanded: boolean;
  codexReasoningExpanded: boolean;
  gitBinaryPath: string;
  githubCliBinaryPath: string;
  sourceControlRefreshIntervalSeconds: number;
  defaultUseWorktree: boolean;
  /** Hours a session stays in the holding state before returning to idle. */
  holdingHours: number;
  autoTitleEnabled: boolean;
  autoTitleDriver: DriverName;
  autoTitleModel: string;
  autoTitleEffort: EffortLevel;
  prRefreshIntervalSeconds: number;
  prCloneRoot: string;
  prAttributionEnabled: boolean;
  prAttributionText: string;
  prWorkflows: PrWorkflow[];
  opencodeGoUsage: boolean;
}

export type SettingsPatch = Partial<AppSettings>;

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface CwApi {
  checkVersions(): Promise<Array<{
    binary: DriverName;
    binaryPath: string;
    minimum: string;
    actual: string | null;
    available: boolean;
    error: string | null;
    ok: boolean;
  }>>;
  discoverBinaries(binaries?: CliBinary[]): Promise<CliDiscoverResult>;
  verifyBinaryPath(binary: CliBinary, path: string): Promise<CliDiscoveredCandidate>;
  isDev: boolean;
  openHarnessTrace(): Promise<{ ok: boolean; path?: string; error?: string }>;
  listProjects(): Promise<Project[]>;
  addProject(rootPath: string): Promise<Project>;
  getHomeDir(): Promise<string>;
  listSessions(projectId: string): Promise<Session[]>;
  listDiscovered(projectId: string): Promise<Session[]>;
  importSession(projectId: string, driver: DriverName, resumeCursor: string, title: string): Promise<Session>;
  createSession(projectId: string, driver: DriverName, options?: CreateSessionOptions): Promise<Session>;
  renameSession(sessionId: string, title: string): Promise<void>;
  regenerateSessionTitle(sessionId: string): Promise<string>;
  setSessionStatus(sessionId: string, status: SessionStatus): Promise<Session>;
  expireHolding(sessionIds: string[]): Promise<Session[]>;
  resolveSession(sessionId: string, status: SessionStatus, removeWorktree?: boolean, forceBranch?: boolean): Promise<SessionCleanupResult>;
  pruneStaleWorktrees(): Promise<WorktreePruneSummary>;
  getHistory(sessionId: string): Promise<HistoryMessage[]>;
  getSubagentTools(sessionId: string, agentId: string): Promise<SubagentToolsResult>;
  activeTurns(): Promise<ActiveTurn[]>;
  retryConnection(sessionId: string): Promise<RetryConnectionResult>;
  startTurn(sessionId: string, prompt: string, opts?: { prefs?: ComposerPrefs; attachments?: string[]; command?: CommandInvocation; prRefs?: PrRef[] }): Promise<string>;
  interrupt(turnId: string): Promise<void>;
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  respondQuestion(requestId: string, answers: Record<string, string>): Promise<void>;
  listCommands(sessionId: string): Promise<CommandOption[]>;
  listCommandsFor(projectId: string, driver: DriverName): Promise<CommandOption[]>;
  listModels(sessionId: string): Promise<ModelOption[]>;
  listModelsFor(projectId: string, driver: DriverName): Promise<ModelOption[]>;
  listModelsForHarness(driver: DriverName): Promise<ModelOption[]>;
  listPermissions(sessionId: string): Promise<PermissionOption[]>;
  listPermissionsFor(projectId: string, driver: DriverName): Promise<PermissionOption[]>;
  listPermissionsForHarness(driver: DriverName): Promise<PermissionOption[]>;
  getComposer(sessionId: string): Promise<ComposerPrefs>;
  setComposer(sessionId: string, prefs: ComposerPrefs): Promise<ComposerPrefs>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: SettingsPatch): Promise<AppSettings>;
  getDefaultPrWorkflows(): Promise<PrWorkflow[]>;
  skills: {
    list(): Promise<SkillsListResult>;
    get(name: string): Promise<SkillDetail>;
    save(input: SkillSaveInput): Promise<SkillDetail>;
    remove(name: string): Promise<SkillsListResult>;
    setEnabled(name: string, harness: HarnessId, on: boolean): Promise<SkillMeta>;
    importAll(): Promise<SkillsListResult>;
  };
  getGitStatus(sessionId: string): Promise<GitStatus>;
  listGitBranches(sessionId: string): Promise<GitBranchInfo[]>;
  listProjectBranches(projectId: string): Promise<GitBranchInfo[]>;
  switchGitBranch(sessionId: string, branch: string): Promise<GitStatus>;
  getGitDiff(sessionId: string, mode: GitDiffMode, baseRef?: string): Promise<GitDiffResult>;
  getSourceControlHealth(projectId?: string): Promise<SourceControlHealth>;
  setProjectGitHubAccount(projectId: string, account: { host: string; login: string } | null): Promise<Project>;
  setRepositoryGitIdentity(projectId: string, name: string, email: string): Promise<void>;
  getUsageLedger(query: UsageLedgerQuery): Promise<UsageLedgerRow[]>;
  getAccountUsage(drivers: DriverName[], force?: boolean): Promise<AccountUsageSnapshot[]>;
  getPrInbox(force?: boolean): Promise<PrInboxResult>;
  getPrDetail(ref: PrRef): Promise<PrDetail>;
  getPrDiff(ref: PrRef): Promise<string>;
  getPrCheckLog(ref: PrRef, runId: number): Promise<string>;
  clonePrRepo(ref: PrRef): Promise<Project>;
  getProjectGitHubRepos(): Promise<ProjectGitHubRepo[]>;
  linkSessionPr(sessionId: string, link: SessionPrLink): Promise<Session>;
  unlinkSessionPr(sessionId: string, ref: PrRef): Promise<Session>;
  markSessionPrSeen(sessionId: string, ref: PrRef, headSha: string | null, seenAt: number | null): Promise<Session>;
  onTurnEvent(cb: (msg: { sessionId: string; event: TurnEvent }) => void): () => void;
  onSessionTitle(cb: (msg: { sessionId: string; title: string }) => void): () => void;
  onSessionUpdated(cb: (session: Session) => void): () => void;
  readFile(sessionId: string, path: string): Promise<string>;
  readOutsideFile(path: string): Promise<string>;
  saveFile(sessionId: string, path: string, content: string): Promise<void>;
  listFiles(sessionId: string): Promise<string[]>;
  listProjectFiles(projectId: string): Promise<string[]>;
  listDir(sessionId: string, dir?: string): Promise<DirEntry[]>;
  savePasteImage(projectId: string, mime: string, data: Uint8Array): Promise<string>;
  readImage(args: { sessionId?: string; projectId?: string; path: string }): Promise<{ mime: string; base64: string }>;
  turnDiff(sessionId: string, since: number): Promise<string>;
  openPty(sessionId: string, kind: DriverName | "shell"): Promise<{ ptyId: string; token: string; replay: string }>;
  writePty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number): void;
  detachPty(ptyId: string, token: string): void;
  killPty(ptyId: string): void;
  onPtyData(cb: (msg: { ptyId: string; data: string }) => void): () => void;
  onPtyExit(cb: (msg: { ptyId: string; token: string; exitCode: number }) => void): () => void;
  minimizeWindow(): void;
  toggleMaximizeWindow(): void;
  closeWindow(): void;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximized(cb: (maximized: boolean) => void): () => void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  getTerminalFont(): Promise<string | null>;
  pickProjectDir(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openHtml(name: string, html: string): Promise<void>;
}

declare global {
  interface Window {
    cw: CwApi;
  }
}
