import type {
  AccountUsageOk,
  AccountUsageSnapshot,
  AccountUsageState,
  AccountUsageUnavailableReason,
  AttentionState,
  CliBinary,
  CliDiscoveredCandidate,
  CliDiscoverResult,
  CommandInvocation,
  CommandOption,
  ContextCompactionInfo,
  ContextUsage,
  DesktopApi,
  DirEntry,
  FileReadResult,
  FileStatInfo,
  FsChangeEvent,
  GitDecorations,
  GitBranchInfo,
  GitDiffMode,
  GitDiffResult,
  GitHubAccountInfo,
  GitHubAccountSelectionSource,
  GitPullRequest,
  GitStatus,
  GitStatusUpdate,
  PrLinkSnapshot,
  SourceControlHealth,
  TurnChanges,
  TurnFileChange,
  TurnSnapshot,
  GitBaseline,
  HarnessId,
  ImportableSession,
  ImportSessionRequest,
  PrBucket,
  PrCheck,
  PrCiState,
  PrCommit,
  PrDetail,
  NotificationSoundEvent,
  NotificationSoundId,
  NotificationSoundPreference,
  NotificationSoundSettings,
  CustomTheme,
  ThemeBase,
  PrFinishedSessionStatus,
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
  GitHubAccountRef,
  GitHubKind,
  GitHubSearchResult,
  GitHubViewDef,
  GitHubViewGroup,
  IssueComment,
  IssueDetail,
  IssueLinkedPr,
  IssueRef,
  IssueSummary,
  RepoRef,
  RunConclusion,
  RunJob,
  RunRef,
  RunSources,
  RunStatus,
  RunsResult,
  SavedGitHubView,
  SessionIssueLink,
  SessionRunLink,
  WorkflowRunSummary,
  WorkflowSubject,
  ShutdownActiveTurn,
  ShutdownAssessment,
  ShutdownCommitResult,
  ShutdownExpiredEvent,
  ShutdownPrepareRequest,
  ShutdownPrepareResult,
  ShutdownReason,
  ShutdownRequestedEvent,
  ShutdownTerminal,
  SkillDetail,
  SkillMeta,
  SkillSaveInput,
  SkillsListResult,
  StartupState,
  TaskEndReason,
  TaskKind,
  TaskSnapshot,
  TaskState,
  TextSearchQuery,
  TextSearchResult,
  TokenCounts,
  TurnModelUsage,
  UpdateActionCode,
  UpdateActionResult,
  UpdateChannel,
  UpdateInstallRequest,
  UpdatePhase,
  UpdateProgress,
  UpdateState,
  UsageBalance,
  UsageLedgerQuery,
  UsageLedgerRow,
  UsageSeverity,
  UsageWindow
} from "@cw-code/contracts";

export type {
  GitBranchInfo,
  GitDiffMode,
  GitDiffResult,
  GitHubAccountInfo,
  GitHubAccountSelectionSource,
  GitPullRequest,
  GitStatus,
  GitStatusUpdate,
  PrLinkSnapshot,
  SourceControlHealth,
  TurnChanges,
  TurnFileChange,
  TurnSnapshot,
  DirEntry,
  ImportableSession,
  ImportSessionRequest,
  NotificationSoundEvent,
  NotificationSoundId,
  NotificationSoundPreference,
  NotificationSoundSettings,
  CustomTheme,
  ThemeBase,
  ShutdownActiveTurn,
  ShutdownAssessment,
  ShutdownCommitResult,
  ShutdownExpiredEvent,
  ShutdownPrepareRequest,
  ShutdownPrepareResult,
  ShutdownReason,
  ShutdownTerminal,
  AccountUsageOk,
  AccountUsageSnapshot,
  AccountUsageState,
  AccountUsageUnavailableReason,
  ContextCompactionInfo,
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
  GitHubAccountRef,
  GitHubKind,
  GitHubSearchResult,
  GitHubViewDef,
  GitHubViewGroup,
  IssueComment,
  IssueDetail,
  IssueLinkedPr,
  IssueRef,
  IssueSummary,
  RepoRef,
  RunConclusion,
  RunJob,
  RunRef,
  RunSources,
  RunStatus,
  RunsResult,
  SavedGitHubView,
  SessionIssueLink,
  SessionRunLink,
  WorkflowRunSummary,
  WorkflowSubject,
  TaskEndReason,
  TaskKind,
  TaskSnapshot,
  TaskState,
  TokenCounts,
  TurnModelUsage,
  UpdateActionCode,
  UpdateActionResult,
  UpdateChannel,
  UpdateInstallRequest,
  UpdatePhase,
  UpdateProgress,
  UpdateState,
  UsageBalance,
  UsageLedgerQuery,
  UsageLedgerRow,
  UsageSeverity,
  UsageWindow
};

export interface ProjectSettings {
  defaultDriver?: DriverName;
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  defaultPermissionMode?: PermissionMode;
  setupScript?: string;
  destroyScript?: string;
  titleInstructions?: string;
  branchInstructions?: string;
}

export interface Project {
  id: string;
  rootPath: string;
  name: string;
  githubAccount?: { host: string; login: string };
  settings?: ProjectSettings;
}

import type { ResolvedCheckout, SessionStatusReason } from "@cw-code/contracts";

export type DriverName = "claude" | "opencode" | "codex";

export type SessionStatus = "idle" | "working" | "input-required" | "done" | "holding" | "babysit" | "resolved" | "archived";

export type { SessionStatusReason };

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
  baseRef?: string;
  prs?: SessionPrLink[];
  issues?: SessionIssueLink[];
  runs?: SessionRunLink[];
  prUnlinked?: string[];
  autoResolved?: boolean;
  resolvedCheckout?: ResolvedCheckout;
  effectivePermissionMode?: string;
  lastTurnSnapshot?: TurnSnapshot;
  createNotice?: string;
}

export type CreateWorkspaceMode = "current" | "new" | "previous";

export interface CreateSessionOptions {
  baseBranch?: string;
  baseFallback?: "default";
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
  destroyScriptErrors: string[];
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
  compaction?: ContextCompactionInfo;
  toolOutputEmpty?: boolean;
  task?: TaskSnapshot;
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
  | { type: "turn.started"; turnId: string; sessionId: string; startedAt: number; prompt: string }
  | { type: "turn.interrupted"; turnId: string; sessionId: string; reason?: "shutdown" }
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
      task?: TaskSnapshot;
    }
  | { type: "task.updated"; turnId: string; sessionId: string; task: TaskSnapshot }
  | {
      type: "tool.result";
      turnId: string;
      toolCallId: string;
      output: string;
      isError: boolean;
      usage?: ToolUsage;
      agentId?: string;
      model?: string;
      outputEmpty?: boolean;
    }
  | { type: "approval.request"; turnId: string; request: ApprovalRequest }
  | { type: "approval.resolved"; turnId: string; requestId: string }
  | { type: "permission.mode.reported"; turnId: string; mode: string | null }
  | { type: "question.request"; turnId: string; request: QuestionRequest }
  | {
      type: "question.resolved";
      turnId: string;
      requestId: string;
      answers: Record<string, string> | null;
    }
  | { type: "todo.updated"; turnId: string; todos: TodoItem[] }
  | {
      type: "context.compacted";
      turnId: string;
      compaction: ContextCompactionInfo;
      context?: ContextUsage;
    }
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
  | { type: "session.branch.updated"; turnId: string; sessionId: string; branch: string }
  | { type: "session.notice"; turnId: string; sessionId: string; noticeId: string; text: string; severity: "info" | "warning" | "error" };

export type PermissionMode = "auto" | "acceptEdits" | "bypassPermissions" | "manual";

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

export interface PermissionOption {
  id: PermissionMode;
  label: string;
  description: string;
  native: boolean;
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
  codexDefaultModel: string;
  opencodeDefaultModel: string;
  claudeEnabledModels: string[];
  claudeCustomModel: CustomModel;
  claudeReasoningExpanded: boolean;
  claudeChromeEnabled: boolean;
  opencodeReasoningExpanded: boolean;
  codexReasoningExpanded: boolean;
  gitBinaryPath: string;
  githubCliBinaryPath: string;
  sourceControlRefreshIntervalSeconds: number;
  defaultUseWorktree: boolean;
  prFinishedSessionStatus: PrFinishedSessionStatus;
  idleResolveAfterDays: number;
  holdingAutoExpireEnabled: boolean;
  /** Hours a session stays in the holding state before returning to idle. */
  holdingHours: number;
  autoTitleEnabled: boolean;
  autoTitleDriver: DriverName;
  autoTitleModel: string;
  autoTitleEffort: EffortLevel;
  prRefreshIntervalSeconds: number;
  prCloneRoot: string;
  /** Append the repository owner as a folder under the clone root. */
  prCloneIncludeOwner: boolean;
  prAttributionEnabled: boolean;
  prAttributionText: string;
  prWorkflows: PrWorkflow[];
  githubSavedViews: SavedGitHubView[];
  opencodeGoUsage: boolean;
  updateChannel: UpdateChannel | null;
  updateBackgroundDownload: boolean;
  fontFamilySans: string;
  fontFamilyMono: string;
  fontFamilyPrompt: string;
  fontFamilyTerminal: string;
  fontSizeInterface: number;
  fontSizeCode: number;
  fontSizePrompt: number;
  fontSizeTerminal: number;
  typographyAdvanced: boolean;
  panelAnimationMs: number;
  notificationSounds: NotificationSoundSettings;
  themeId: string;
  customThemes: CustomTheme[];
  serverBindHost: string;
}

export type SettingsPatch = Partial<AppSettings>;

export interface CwApi {
  getStartupState(): Promise<StartupState>;
  recovery: {
    openDataDir(): Promise<void>;
    restore(file: string, backupPath: string): Promise<void>;
    startFresh(file: string): Promise<void>;
    retry(): Promise<void>;
  };
  updates: {
    getState(): Promise<UpdateState>;
    check(): Promise<UpdateActionResult>;
    download(): Promise<UpdateActionResult>;
    setChannel(channel: UpdateChannel): Promise<UpdateActionResult>;
    install(request: UpdateInstallRequest): Promise<UpdateActionResult>;
    onChanged(cb: (state: UpdateState) => void): () => void;
  };
  shutdown: {
    assess(): Promise<ShutdownAssessment>;
    prepare(request: ShutdownPrepareRequest): Promise<ShutdownPrepareResult>;
    force(token: string): Promise<ShutdownPrepareResult>;
    cancel(token: string): Promise<void>;
    quit(token: string): Promise<ShutdownCommitResult>;
    onRequested(cb: (event: ShutdownRequestedEvent) => void): () => void;
    onExpired(cb: (event: ShutdownExpiredEvent) => void): () => void;
  };
  checkVersions(): Promise<Array<{
    binary: DriverName;
    binaryPath: string;
    minimum: string;
    actual: string | null;
    configured: boolean;
    found: boolean;
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
  updateProjectSettings(projectId: string, settings: ProjectSettings): Promise<Project>;
  getHomeDir(): Promise<string>;
  listSessions(projectId: string): Promise<Session[]>;
  createSession(projectId: string, driver: DriverName, options?: CreateSessionOptions): Promise<Session>;
  listImportableSessions(driver: DriverName): Promise<ImportableSession[]>;
  importSession(request: ImportSessionRequest): Promise<{ project: Project; session: Session }>;
  renameSession(sessionId: string, title: string): Promise<void>;
  regenerateSessionTitle(sessionId: string): Promise<string>;
  setSessionStatus(sessionId: string, status: SessionStatus, reason?: SessionStatusReason): Promise<Session>;
  markSessionWorking(sessionId: string): Promise<Session>;
  restoreSession(sessionId: string): Promise<Session>;
  expireHolding(sessionIds: string[]): Promise<Session[]>;
  resolveSession(sessionId: string, status: SessionStatus, removeWorktree?: boolean, forceBranch?: boolean): Promise<SessionCleanupResult>;
  pruneStaleWorktrees(): Promise<WorktreePruneSummary>;
  getHistory(sessionId: string): Promise<HistoryMessage[]>;
  getSubagentTools(sessionId: string, agentId: string): Promise<SubagentToolsResult>;
  activeTurns(): Promise<ActiveTurn[]>;
  retryConnection(sessionId: string): Promise<RetryConnectionResult>;
  startTurn(sessionId: string, prompt: string, opts?: { prefs?: ComposerPrefs; attachments?: string[]; command?: CommandInvocation; skills?: string[]; prRefs?: PrRef[]; finalReview?: { ref: PrRef; sha: string }; acceptFolderHead?: string }): Promise<string>;
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
  onGitStatus(cb: (update: GitStatusUpdate) => void): () => void;
  listGitBranches(sessionId: string): Promise<GitBranchInfo[]>;
  listProjectBranches(projectId: string): Promise<GitBranchInfo[]>;
  switchGitBranch(sessionId: string, branch: string): Promise<GitStatus>;
  getGitDiff(sessionId: string, mode: GitDiffMode, baseRef?: string): Promise<GitDiffResult>;
  getTurnChanges(sessionId: string): Promise<TurnChanges | null>;
  undoTurn(sessionId: string, turnId: string, expectedEndSha: string): Promise<TurnChanges>;
  getSourceControlHealth(projectId?: string): Promise<SourceControlHealth>;
  setProjectGitHubAccount(projectId: string, account: { host: string; login: string } | null): Promise<Project>;
  setRepositoryGitIdentity(projectId: string, name: string, email: string): Promise<void>;
  getUsageLedger(query: UsageLedgerQuery): Promise<UsageLedgerRow[]>;
  getAccountUsage(drivers: DriverName[], force?: boolean): Promise<AccountUsageSnapshot[]>;
  getPrInbox(force?: boolean): Promise<PrInboxResult>;
  getTrackedPrs(): Promise<PrSummary[]>;
  onTrackedPrs(cb: (items: PrSummary[]) => void): () => void;
  getPrDetail(ref: PrRef): Promise<PrDetail>;
  getPrDiff(ref: PrRef): Promise<string>;
  getPrCheckLog(ref: PrRef, runId: number): Promise<string>;
  searchGitHub(kind: "pr", query: string, countBase: string, force?: boolean): Promise<GitHubSearchResult<PrSummary>>;
  searchGitHub(kind: "issue", query: string, countBase: string, force?: boolean): Promise<GitHubSearchResult<IssueSummary>>;
  countGitHub(kind: "pr" | "issue", queries: string[]): Promise<Array<number | null>>;
  getIssueDetail(ref: IssueRef): Promise<IssueDetail>;
  getGitHubRuns(sources: RunSources, force?: boolean): Promise<RunsResult>;
  getRunLog(ref: RunRef): Promise<string>;
  watchGitHubRuns(refs: RunRef[]): Promise<void>;
  onGitHubRunsChanged(cb: (runs: WorkflowRunSummary[]) => void): () => void;
  onGitHubCiActivity(cb: () => void): () => void;
  subscribeTopics(topics: readonly string[]): () => void;
  cloneGitHubRepo(repo: RepoRef): Promise<Project>;
  getProjectGitHubRepos(): Promise<ProjectGitHubRepo[]>;
  linkSessionPr(sessionId: string, link: SessionPrLink): Promise<Session>;
  unlinkSessionPr(sessionId: string, ref: PrRef): Promise<Session>;
  markSessionPrSeen(sessionId: string, ref: PrRef, headSha: string | null, seenAt: number | null): Promise<Session>;
  linkSessionIssue(sessionId: string, link: SessionIssueLink): Promise<Session>;
  unlinkSessionIssue(sessionId: string, ref: IssueRef): Promise<Session>;
  markSessionIssueSeen(sessionId: string, ref: IssueRef, seenAt: number): Promise<Session>;
  linkSessionRun(sessionId: string, link: SessionRunLink): Promise<Session>;
  unlinkSessionRun(sessionId: string, ref: RunRef): Promise<Session>;
  markSessionRunSeen(sessionId: string, ref: RunRef, seenAt: number): Promise<Session>;
  onTurnEvent(cb: (msg: { sessionId: string; event: TurnEvent }) => void): () => void;
  onSessionTitle(cb: (msg: { sessionId: string; title: string }) => void): () => void;
  onSessionUpdated(cb: (session: Session) => void): () => void;
  onProjectChanged(cb: (project: Project) => void): () => void;
  onSettingsChanged(cb: (settings: AppSettings) => void): () => void;
  onSkillsChanged(cb: (result: SkillsListResult) => void): () => void;
  onComposerChanged(cb: (event: ComposerChangedEvent) => void): () => void;
  readFile(sessionId: string, path: string): Promise<string>;
  readOutsideFile(path: string): Promise<string>;
  listFiles(sessionId: string): Promise<string[]>;
  listProjectFiles(projectId: string): Promise<string[]>;
  listDir(sessionId: string, dir?: string): Promise<DirEntry[]>;
  readFileInfo(sessionId: string, path: string): Promise<FileReadResult>;
  writeFileGuarded(sessionId: string, path: string, content: string, expectedMtimeMs?: number): Promise<FileStatInfo>;
  createFile(sessionId: string, path: string): Promise<void>;
  createDir(sessionId: string, path: string): Promise<void>;
  renamePath(sessionId: string, from: string, to: string): Promise<void>;
  trashPath(sessionId: string, path: string): Promise<void>;
  revealPath(sessionId: string, path: string): Promise<void>;
  workspaceRoot(sessionId: string): Promise<string>;
  listWorkspaceFiles(sessionId: string): Promise<string[]>;
  gitDecorations(sessionId: string): Promise<GitDecorations>;
  gitBaseline(sessionId: string, path: string): Promise<GitBaseline>;
  searchText(sessionId: string, query: TextSearchQuery): Promise<TextSearchResult>;
  setWatchedPaths(sessionId: string, paths: string[]): Promise<void>;
  onFsChanged(cb: (e: FsChangeEvent) => void): () => void;
  savePasteImage(projectId: string, mime: string, data: Uint8Array): Promise<string>;
  readImage(args: { sessionId?: string; projectId?: string; path: string }): Promise<{ mime: string; base64: string }>;
  openPty(sessionId: string, kind: DriverName | "shell"): Promise<{ ptyId: string; token: string; replay: string }>;
  writePty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number): void;
  detachPty(ptyId: string): void;
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
  setAttention(state: AttentionState): void;
  pickProjectDir(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openHtml(name: string, html: string): Promise<void>;
}

declare global {
  interface Window {
    cw: CwApi;
    cwDesktop: DesktopApi;
  }
}
