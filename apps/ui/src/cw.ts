import type { TopicCache } from "@cw-code/client";
import type { UiCapabilities } from "./platform/capabilities.js";
import type {
  AccountUsageEntry,
  AccountUsageOk,
  AccountUsageSnapshot,
  AccountUsageState,
  AccountUsageUnavailableReason,
  BranchMismatch,
  CliBinary,
  HarnessAvailability,
  LegacyPreferences,
  SidebarReorderRequest,
  CliDiscoveredCandidate,
  CliDiscoverResult,
  CommandInvocation,
  CommandOption,
  ContextCompactionInfo,
  ContextUsage,
  DesktopApi,
  DesktopConnections,
  DeviceCreateResult,
  DeviceInfo,
  DesktopUpdates,
  DirectoryListing,
  DirEntry,
  FileReadResult,
  FileStatInfo,
  FsChangeEvent,
  GitBranchInfo,
  GitDiffMode,
  GitDiffResult,
  GitHubAccountInfo,
  GitHubAccountSelectionSource,
  GitPullRequest,
  GitStatus,
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
  RunStatus,
  SavedGitHubView,
  SessionIssueLink,
  SessionRunLink,
  ServerHost,
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
  ShutdownScope,
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
  UsageMetric,
  UsageReport,
  UsageReportQuery,
  UsageSeverity,
  UsageTopicData,
  UsageTotals,
  UsageWindow,
  WorkflowHarnessRequest,
  WorkflowHarnessResult,
  WorkflowPreview,
  WorkflowPreviewRequest,
  WorkflowRunRequest,
  WorkflowRunResult,
  WorkflowTemplatePreview,
  WorkflowTemplatePreviewRequest
} from "@cw-code/contracts";

export type {
  GitBranchInfo,
  GitDiffMode,
  GitDiffResult,
  GitHubAccountInfo,
  GitHubAccountSelectionSource,
  GitPullRequest,
  GitStatus,
  PrLinkSnapshot,
  SourceControlHealth,
  TurnChanges,
  TurnFileChange,
  TurnSnapshot,
  DirEntry,
  DirectoryListing,
  ServerHost,
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
  ShutdownScope,
  ShutdownTerminal,
  AccountUsageEntry,
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
  RunStatus,
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
  UsageMetric,
  UsageReport,
  UsageReportQuery,
  UsageSeverity,
  UsageTopicData,
  UsageTotals,
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

import type { ResolvedCheckout, SessionOpenReason, SessionStatusReason } from "@cw-code/contracts";

export type DriverName = "claude" | "opencode" | "codex";

export type SessionStatus = "idle" | "working" | "input-required" | "done" | "holding" | "babysit" | "resolved" | "archived";

export type { SessionOpenReason, SessionStatusReason };

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

export interface StopTurnResult {
  stopped: boolean;
}

export interface RetryConnectionResult {
  status: "running" | "done";
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
  keepServerRunning: boolean;
  serverPublicUrl: string;
}

export type SettingsPatch = Partial<AppSettings>;

export interface SaveGitHubViewInput {
  kind: GitHubKind;
  name: string;
  query: string;
  group: GitHubViewGroup;
}

export interface PtyAttachment {
  ptyId: string;
  token: string;
  replay: string;
}

export interface CwApi {
  topics: TopicCache;
  getStartupState(): Promise<StartupState>;
  capabilities: UiCapabilities;
  shell: ShellActions | null;
  local: LocalActions | null;
  recovery: {
    restore(file: string, backupPath: string): Promise<void>;
    startFresh(file: string): Promise<void>;
    retry(): Promise<void>;
  };
  shutdown: {
    assess(): Promise<ShutdownAssessment>;
    prepare(request: ShutdownPrepareRequest): Promise<ShutdownPrepareResult>;
    force(token: string): Promise<ShutdownPrepareResult>;
    cancel(token: string): Promise<void>;
    quit(token: string): Promise<ShutdownCommitResult>;
    quitWindow(): void;
    acknowledge(): void;
    onRequested(cb: (event: ShutdownRequestedEvent) => void): () => void;
    onExpired(cb: (event: ShutdownExpiredEvent) => void): () => void;
  };
  recheckClis(): Promise<HarnessAvailability>;
  importLegacyPrefs(legacy: LegacyPreferences): Promise<void>;
  reorderSidebar(request: SidebarReorderRequest): Promise<void>;
  pushRecentModel(driver: DriverName, model: string): Promise<void>;
  setComposerDraft(key: string, text: string, attachments: readonly string[]): Promise<void>;
  discoverBinaries(binaries?: CliBinary[]): Promise<CliDiscoverResult>;
  verifyBinaryPath(binary: CliBinary, path: string): Promise<CliDiscoveredCandidate>;
  isDev: boolean;
  addProject(rootPath: string): Promise<Project>;
  updateProjectSettings(projectId: string, settings: ProjectSettings): Promise<Project>;
  createSession(projectId: string, driver: DriverName, options?: CreateSessionOptions): Promise<Session>;
  listImportableSessions(driver: DriverName): Promise<ImportableSession[]>;
  importSession(request: ImportSessionRequest): Promise<{ project: Project; session: Session }>;
  renameSession(sessionId: string, title: string): Promise<void>;
  regenerateSessionTitle(sessionId: string): Promise<string>;
  setSessionStatus(sessionId: string, status: SessionStatus, reason?: SessionStatusReason): Promise<Session>;
  markSessionWorking(sessionId: string): Promise<Session>;
  restoreSession(sessionId: string): Promise<Session>;
  markTurnSeen(sessionId: string): Promise<void>;
  openSession(sessionId: string, reason: SessionOpenReason): Promise<void>;
  pauseAutoFollowUp(sessionId: string): Promise<void>;
  resumeAutoFollowUp(sessionId: string): Promise<void>;
  resolveSession(sessionId: string, status: SessionStatus, removeWorktree?: boolean, forceBranch?: boolean): Promise<SessionCleanupResult>;
  pruneStaleWorktrees(): Promise<WorktreePruneSummary>;
  getSubagentTools(sessionId: string, agentId: string): Promise<SubagentToolsResult>;
  retryConnection(sessionId: string): Promise<RetryConnectionResult>;
  startTurn(sessionId: string, prompt: string, opts?: { prefs?: ComposerPrefs; attachments?: string[]; command?: CommandInvocation; skills?: string[]; prRefs?: PrRef[]; acceptFolderHead?: string }): Promise<string>;
  stopTurn(sessionId: string): Promise<StopTurnResult>;
  reloadHistory(sessionId: string): Promise<void>;
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
  refreshGit(sessionId: string): Promise<void>;
  checkBranchMismatch(sessionId: string): Promise<BranchMismatch | null>;
  keepFolderHead(sessionId: string): Promise<string | null>;
  listGitBranches(sessionId: string): Promise<GitBranchInfo[]>;
  listProjectBranches(projectId: string): Promise<GitBranchInfo[]>;
  switchGitBranch(sessionId: string, branch: string): Promise<GitStatus>;
  getGitDiff(sessionId: string, mode: GitDiffMode, baseRef?: string): Promise<GitDiffResult>;
  getTurnChanges(sessionId: string): Promise<TurnChanges | null>;
  undoTurn(sessionId: string, turnId: string, expectedEndSha: string): Promise<TurnChanges>;
  getSourceControlHealth(projectId?: string): Promise<SourceControlHealth>;
  setProjectGitHubAccount(projectId: string, account: { host: string; login: string } | null): Promise<Project>;
  setRepositoryGitIdentity(projectId: string, name: string, email: string): Promise<void>;
  usageReport(query: UsageReportQuery): Promise<UsageReport>;
  refreshAccountUsage(force: boolean, drivers?: DriverName[]): Promise<void>;
  refreshPrInbox(force?: boolean): Promise<void>;
  getPrDetail(ref: PrRef): Promise<PrDetail>;
  watchPrDetail(ref: PrRef): Promise<void>;
  unwatchPrDetail(ref: PrRef): Promise<void>;
  getPrDiff(ref: PrRef): Promise<string>;
  getPrCheckLog(ref: PrRef, runId: number): Promise<string>;
  refreshGitHubView(topic: string, force?: boolean): Promise<void>;
  githubViewCounts(kind: GitHubKind): Promise<Record<string, number | null>>;
  saveGitHubView(input: SaveGitHubViewInput): Promise<SavedGitHubView>;
  renameGitHubView(id: string, name: string): Promise<void>;
  deleteGitHubView(id: string): Promise<void>;
  workflowPreview(req: WorkflowPreviewRequest): Promise<WorkflowPreview>;
  workflowHarness(req: WorkflowHarnessRequest): Promise<WorkflowHarnessResult>;
  workflowTemplatePreview(req: WorkflowTemplatePreviewRequest): Promise<WorkflowTemplatePreview>;
  runWorkflow(req: WorkflowRunRequest): Promise<WorkflowRunResult>;
  linkSessionPr(sessionId: string, link: SessionPrLink): Promise<Session>;
  unlinkSessionPr(sessionId: string, ref: PrRef): Promise<Session>;
  sendPrUpdates(sessionId: string, keys: string[]): Promise<string>;
  dismissPrUpdates(sessionId: string, keys: string[]): Promise<void>;
  onProjectChanged(cb: (project: Project) => void): () => void;
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
  workspaceRoot(sessionId: string): Promise<string>;
  listWorkspaceFiles(sessionId: string): Promise<string[]>;
  gitBaseline(sessionId: string, path: string): Promise<GitBaseline>;
  searchText(sessionId: string, query: TextSearchQuery): Promise<TextSearchResult>;
  setWatchedPaths(sessionId: string, paths: string[]): Promise<void>;
  onFsChanged(cb: (e: FsChangeEvent) => void): () => void;
  savePasteImage(projectId: string, mime: string, data: Uint8Array): Promise<string>;
  readImage(args: { sessionId?: string; projectId?: string; path: string }): Promise<{ mime: string; base64: string }>;
  openPty(sessionId: string, kind: DriverName | "shell"): Promise<PtyAttachment>;
  reattachPty(sessionId: string, kind: DriverName | "shell", token: string): Promise<PtyAttachment | null>;
  writePty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number): void;
  detachPty(ptyId: string): void;
  onPtyData(cb: (msg: { ptyId: string; data: string }) => void): () => void;
  onPtyExit(cb: (msg: { ptyId: string; token: string; exitCode: number }) => void): () => void;
  openExternal(url: string): Promise<void>;
  openHtml(name: string, html: string): Promise<void>;
  browseDirectories(path?: string | null, showHidden?: boolean): Promise<DirectoryListing>;
  getServerHost(): Promise<ServerHost>;
  devices: {
    list(): Promise<DeviceInfo[]>;
    create(name: string): Promise<DeviceCreateResult>;
    revoke(id: string): Promise<void>;
  };
  onDevicesChanged(cb: (devices: DeviceInfo[]) => void): () => void;
}

export interface ShellActions {
  minimizeWindow(): void;
  toggleMaximizeWindow(): void;
  closeWindow(): void;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximized(cb: (maximized: boolean) => void): () => void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  stopServerAndQuit(): void;
  updates: DesktopUpdates;
  connections: DesktopConnections;
}

export interface LocalActions {
  pickProjectDir(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  revealPath(sessionId: string, path: string): Promise<void>;
  openDataDir(): Promise<void>;
  openHarnessTrace(): Promise<{ ok: boolean; path?: string; error?: string }>;
}

declare global {
  interface Window {
    cw: CwApi;
    cwDesktop: DesktopApi | undefined;
  }
}
