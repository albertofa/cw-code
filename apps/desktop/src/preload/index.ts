import { contextBridge, ipcRenderer } from "electron";
import type { AccountUsageSnapshot, AppSettings, CliBinary, CliDiscoveredCandidate, CliDiscoverResult, CommandInvocation, CommandOption, CreateSessionOptions, GitBranchInfo, GitDiffMode, GitDiffResult, GitStatus, HarnessId, PrDetail, PrInboxResult, Project, ProjectGitHubRepo, PrRef, PrWorkflow, RetryConnectionResult, SessionCleanupResult, SessionMeta, SessionPrLink, SessionStatus, ShutdownAssessment, ShutdownCommitResult, ShutdownExpiredEvent, ShutdownPrepareRequest, ShutdownPrepareResult, ShutdownRequestedEvent, SkillDetail, SkillMeta, SkillSaveInput, SkillsListResult, SourceControlHealth, StartupState, SubagentToolsResult, UpdateActionResult, UpdateChannel, UpdateInstallRequest, UpdateState, UsageLedgerQuery, UsageLedgerRow, WorktreePruneSummary } from "@cw-code/contracts";

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
}

export interface PermissionOption {
  id: PermissionMode;
  label: string;
  description: string;
  native: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export type DriverName = "claude" | "opencode" | "codex";
export type PtyKindName = DriverName | "shell";

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
  listSessions(projectId: string): Promise<unknown[]>;
  listDiscovered(projectId: string): Promise<unknown[]>;
  importSession(projectId: string, driver: DriverName, resumeCursor: string, title: string): Promise<unknown>;
  createSession(projectId: string, driver: DriverName, options?: CreateSessionOptions): Promise<unknown>;
  renameSession(sessionId: string, title: string): Promise<void>;
  regenerateSessionTitle(sessionId: string): Promise<string>;
  setSessionStatus(sessionId: string, status: SessionStatus): Promise<unknown>;
  expireHolding(sessionIds: string[]): Promise<SessionMeta[]>;
  resolveSession(sessionId: string, status: SessionStatus, removeWorktree?: boolean, forceBranch?: boolean): Promise<SessionCleanupResult>;
  pruneStaleWorktrees(): Promise<WorktreePruneSummary>;
  getHistory(sessionId: string): Promise<unknown[]>;
  getSubagentTools(sessionId: string, agentId: string): Promise<SubagentToolsResult>;
  activeTurns(): Promise<Array<{ sessionId: string; turnId: string; startedAt: number }>>;
  retryConnection(sessionId: string): Promise<RetryConnectionResult>;
  startTurn(sessionId: string, prompt: string, opts?: { prefs?: ComposerPrefs; attachments?: string[]; command?: CommandInvocation; prRefs?: PrRef[] }): Promise<string>;
  interrupt(turnId: string): Promise<void>;
  respondApproval(requestId: string, decision: "accept" | "acceptForSession" | "acceptGlobal" | "decline" | "cancel"): Promise<void>;
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
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
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
  linkSessionPr(sessionId: string, link: SessionPrLink): Promise<SessionMeta>;
  unlinkSessionPr(sessionId: string, ref: PrRef): Promise<SessionMeta>;
  markSessionPrSeen(sessionId: string, ref: PrRef, headSha: string | null, seenAt: number | null): Promise<SessionMeta>;
  onTurnEvent(cb: (event: unknown) => void): () => void;
  onSessionTitle(cb: (msg: { sessionId: string; title: string }) => void): () => void;
  onSessionUpdated(cb: (session: SessionMeta) => void): () => void;
  readFile(sessionId: string, path: string): Promise<string>;
  readOutsideFile(path: string): Promise<string>;
  saveFile(sessionId: string, path: string, content: string): Promise<void>;
  listFiles(sessionId: string): Promise<string[]>;
  listProjectFiles(projectId: string): Promise<string[]>;
  listDir(sessionId: string, dir?: string): Promise<DirEntry[]>;
  savePasteImage(projectId: string, mime: string, data: Uint8Array): Promise<string>;
  readImage(args: { sessionId?: string; projectId?: string; path: string }): Promise<{ mime: string; base64: string }>;
  turnDiff(sessionId: string, since: number): Promise<string>;
  openPty(sessionId: string, kind: PtyKindName): Promise<{ ptyId: string; token: string; replay: string }>;
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

const api: CwApi = {
  getStartupState: () => ipcRenderer.invoke("startup.state"),
  recovery: {
    openDataDir: () => ipcRenderer.invoke("recovery.openDataDir"),
    restore: (file: string, backupPath: string) => ipcRenderer.invoke("recovery.restore", { file, backupPath }),
    startFresh: (file: string) => ipcRenderer.invoke("recovery.startFresh", { file }),
    retry: () => ipcRenderer.invoke("recovery.retry")
  },
  updates: {
    getState: () => ipcRenderer.invoke("updates.state"),
    check: () => ipcRenderer.invoke("updates.check"),
    download: () => ipcRenderer.invoke("updates.download"),
    setChannel: (channel: UpdateChannel) => ipcRenderer.invoke("updates.setChannel", { channel }),
    install: (request: UpdateInstallRequest) => ipcRenderer.invoke("updates.install", request),
    onChanged: (cb) => {
      const listener = (_e: unknown, state: UpdateState) => cb(state);
      ipcRenderer.on("updates.changed", listener as never);
      return () => ipcRenderer.removeListener("updates.changed", listener as never);
    }
  },
  shutdown: {
    assess: () => ipcRenderer.invoke("shutdown.assess"),
    prepare: (request: ShutdownPrepareRequest) => ipcRenderer.invoke("shutdown.prepare", request),
    force: (token: string) => ipcRenderer.invoke("shutdown.force", { token }),
    cancel: (token: string) => ipcRenderer.invoke("shutdown.cancel", { token }),
    quit: (token: string) => ipcRenderer.invoke("shutdown.quit", { token }),
    onRequested: (cb) => {
      const listener = (_e: unknown, event: ShutdownRequestedEvent) => cb(event);
      ipcRenderer.on("shutdown.requested", listener as never);
      return () => ipcRenderer.removeListener("shutdown.requested", listener as never);
    },
    onExpired: (cb) => {
      const listener = (_e: unknown, event: ShutdownExpiredEvent) => cb(event);
      ipcRenderer.on("shutdown.expired", listener as never);
      return () => ipcRenderer.removeListener("shutdown.expired", listener as never);
    }
  },
  checkVersions: () => ipcRenderer.invoke("cli.checkVersions"),
  discoverBinaries: (binaries?: CliBinary[]) => ipcRenderer.invoke("cli.discover", { binaries }),
  verifyBinaryPath: (binary: CliBinary, path: string) =>
    ipcRenderer.invoke("cli.verifyPath", { binary, path }),
  isDev: Boolean(process.env["ELECTRON_RENDERER_URL"]),
  openHarnessTrace: () => ipcRenderer.invoke("debug.openTrace"),
  listProjects: () => ipcRenderer.invoke("projects.list"),
  addProject: (rootPath: string) => ipcRenderer.invoke("projects.add", rootPath),
  getHomeDir: () => ipcRenderer.invoke("os.homeDir"),
  listSessions: (projectId: string) => ipcRenderer.invoke("sessions.list", projectId),
  listDiscovered: (projectId: string) => ipcRenderer.invoke("sessions.discovered", projectId),
  importSession: (projectId: string, driver: DriverName, resumeCursor: string, title: string) =>
    ipcRenderer.invoke("sessions.import", { projectId, driver, resumeCursor, title }),
  createSession: (projectId: string, driver: DriverName, options?: CreateSessionOptions) =>
    ipcRenderer.invoke("sessions.create", { projectId, driver, options }),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke("sessions.rename", { sessionId, title }),
  regenerateSessionTitle: (sessionId: string) =>
    ipcRenderer.invoke("sessions.regenerateTitle", { sessionId }),
  setSessionStatus: (sessionId: string, status: SessionStatus) =>
    ipcRenderer.invoke("sessions.setStatus", { sessionId, status }),
  expireHolding: (sessionIds: string[]) =>
    ipcRenderer.invoke("sessions.expireHolding", sessionIds),
  resolveSession: (sessionId: string, status: SessionStatus, removeWorktree?: boolean, forceBranch?: boolean) =>
    ipcRenderer.invoke("sessions.resolve", { sessionId, status, removeWorktree, forceBranch }),
  pruneStaleWorktrees: () => ipcRenderer.invoke("worktrees.prune"),
  getHistory: (sessionId: string) => ipcRenderer.invoke("sessions.history", { sessionId }),
  getSubagentTools: (sessionId: string, agentId: string) =>
    ipcRenderer.invoke("sessions.subagentTools", { sessionId, agentId }),
  activeTurns: () => ipcRenderer.invoke("sessions.activeTurns"),
  retryConnection: (sessionId: string) => ipcRenderer.invoke("sessions.retryConnection", { sessionId }),
  startTurn: (sessionId: string, prompt: string, opts?: { prefs?: ComposerPrefs; attachments?: string[]; command?: CommandInvocation; prRefs?: PrRef[] }) =>
    ipcRenderer.invoke("turns.start", { sessionId, prompt, prefs: opts?.prefs, attachments: opts?.attachments, command: opts?.command, prRefs: opts?.prRefs }),
  interrupt: (turnId: string) => ipcRenderer.invoke("turns.interrupt", { turnId }),
  respondApproval: (requestId: string, decision: "accept" | "acceptForSession" | "acceptGlobal" | "decline" | "cancel") =>
    ipcRenderer.invoke("approvals.respond", { requestId, decision }),
  respondQuestion: (requestId: string, answers: Record<string, string>) =>
    ipcRenderer.invoke("questions.respond", { requestId, answers }),
  listCommands: (sessionId: string) => ipcRenderer.invoke("commands.list", { sessionId }),
  listCommandsFor: (projectId: string, driver: DriverName) =>
    ipcRenderer.invoke("commands.listFor", { projectId, driver }),
  listModels: (sessionId: string) => ipcRenderer.invoke("models.list", { sessionId }),
  listModelsFor: (projectId: string, driver: DriverName) =>
    ipcRenderer.invoke("models.listFor", { projectId, driver }),
  listModelsForHarness: (driver: DriverName) =>
    ipcRenderer.invoke("models.listForHarness", { driver }),
  listPermissions: (sessionId: string) => ipcRenderer.invoke("permissions.list", { sessionId }),
  listPermissionsFor: (projectId: string, driver: DriverName) =>
    ipcRenderer.invoke("permissions.listFor", { projectId, driver }),
  listPermissionsForHarness: (driver: DriverName) =>
    ipcRenderer.invoke("permissions.listForHarness", { driver }),
  getComposer: (sessionId: string) => ipcRenderer.invoke("composer.get", { sessionId }),
  setComposer: (sessionId: string, prefs: ComposerPrefs) =>
    ipcRenderer.invoke("composer.set", { sessionId, prefs }),
  getSettings: () => ipcRenderer.invoke("settings.get"),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke("settings.set", patch),
  getDefaultPrWorkflows: () => ipcRenderer.invoke("settings.prWorkflowDefaults"),
  skills: {
    list: () => ipcRenderer.invoke("skills.list"),
    get: (name: string) => ipcRenderer.invoke("skills.get", name),
    save: (input: SkillSaveInput) => ipcRenderer.invoke("skills.save", input),
    remove: (name: string) => ipcRenderer.invoke("skills.remove", name),
    setEnabled: (name: string, harness: HarnessId, on: boolean) =>
      ipcRenderer.invoke("skills.setEnabled", { name, harness, on }),
    importAll: () => ipcRenderer.invoke("skills.importAll")
  },
  getGitStatus: (sessionId: string) => ipcRenderer.invoke("git.status", { sessionId }),
  listGitBranches: (sessionId: string) => ipcRenderer.invoke("git.branches", { sessionId }),
  listProjectBranches: (projectId: string) => ipcRenderer.invoke("git.projectBranches", { projectId }),
  switchGitBranch: (sessionId: string, branch: string) => ipcRenderer.invoke("git.switchBranch", { sessionId, branch }),
  getGitDiff: (sessionId: string, mode: GitDiffMode, baseRef?: string) =>
    ipcRenderer.invoke("git.diff", { sessionId, mode, baseRef }),
  getSourceControlHealth: (projectId?: string) => ipcRenderer.invoke("git.health", { projectId }),
  setProjectGitHubAccount: (projectId: string, account: { host: string; login: string } | null) =>
    ipcRenderer.invoke("git.setProjectAccount", { projectId, account }),
  setRepositoryGitIdentity: (projectId: string, name: string, email: string) =>
    ipcRenderer.invoke("git.setIdentity", { projectId, name, email }),
  getUsageLedger: (query: UsageLedgerQuery) => ipcRenderer.invoke("usage.ledger", query),
  getAccountUsage: (drivers: DriverName[], force?: boolean) => ipcRenderer.invoke("usage.account", { drivers, force }),
  getPrInbox: (force?: boolean) => ipcRenderer.invoke("prs.inbox", { force }),
  getPrDetail: (ref: PrRef) => ipcRenderer.invoke("prs.detail", { ref }),
  getPrDiff: (ref: PrRef) => ipcRenderer.invoke("prs.diff", { ref }),
  getPrCheckLog: (ref: PrRef, runId: number) => ipcRenderer.invoke("prs.checkLog", { ref, runId }),
  clonePrRepo: (ref: PrRef) => ipcRenderer.invoke("prs.clone", { ref }),
  getProjectGitHubRepos: () => ipcRenderer.invoke("prs.projectRepos"),
  linkSessionPr: (sessionId: string, link: SessionPrLink) => ipcRenderer.invoke("sessions.linkPr", { sessionId, link }),
  unlinkSessionPr: (sessionId: string, ref: PrRef) => ipcRenderer.invoke("sessions.unlinkPr", { sessionId, ref }),
  markSessionPrSeen: (sessionId: string, ref: PrRef, headSha: string | null, seenAt: number | null) =>
    ipcRenderer.invoke("sessions.markPrSeen", { sessionId, ref, headSha, seenAt }),
  onTurnEvent: (cb) => {
    const listener = (_e: unknown, event: unknown) => cb(event);
    ipcRenderer.on("turn.event", listener as never);
    return () => ipcRenderer.removeListener("turn.event", listener as never);
  },
  onSessionTitle: (cb) => {
    const listener = (_e: unknown, msg: { sessionId: string; title: string }) => cb(msg);
    ipcRenderer.on("session.title", listener as never);
    return () => ipcRenderer.removeListener("session.title", listener as never);
  },
  onSessionUpdated: (cb) => {
    const listener = (_e: unknown, session: SessionMeta) => cb(session);
    ipcRenderer.on("session.updated", listener as never);
    return () => ipcRenderer.removeListener("session.updated", listener as never);
  },
  readFile: (sessionId: string, path: string) => ipcRenderer.invoke("fs.readFile", { sessionId, path }),
  readOutsideFile: (path: string) => ipcRenderer.invoke("fs.readOutsideFile", { path }),
  saveFile: (sessionId: string, path: string, content: string) =>
    ipcRenderer.invoke("fs.saveFile", { sessionId, path, content }),
  listFiles: (sessionId: string) => ipcRenderer.invoke("fs.listFiles", { sessionId }),
  listProjectFiles: (projectId: string) => ipcRenderer.invoke("fs.listProjectFiles", { projectId }),
  listDir: (sessionId: string, dir?: string) => ipcRenderer.invoke("fs.listDir", { sessionId, dir }),
  savePasteImage: (projectId: string, mime: string, data: Uint8Array) =>
    ipcRenderer.invoke("fs.savePasteImage", { projectId, mime, data }),
  readImage: (args: { sessionId?: string; projectId?: string; path: string }) =>
    ipcRenderer.invoke("fs.readImage", args),
  turnDiff: (sessionId: string, since: number) => ipcRenderer.invoke("git.turnDiff", { sessionId, since }),
  openPty: (sessionId: string, kind: PtyKindName) =>
    ipcRenderer.invoke("pty.open", { sessionId, kind }),
  writePty: (ptyId: string, data: string) => ipcRenderer.send("pty.write", { ptyId, data }),
  resizePty: (ptyId: string, cols: number, rows: number) =>
    ipcRenderer.send("pty.resize", { ptyId, cols, rows }),
  detachPty: (ptyId: string, token: string) => ipcRenderer.send("pty.detach", { ptyId, token }),
  killPty: (ptyId: string) => ipcRenderer.send("pty.kill", { ptyId }),
  onPtyData: (cb) => {
    const listener = (_e: unknown, msg: { ptyId: string; data: string }) => cb(msg);
    ipcRenderer.on("pty.data", listener as never);
    return () => ipcRenderer.removeListener("pty.data", listener as never);
  },
  onPtyExit: (cb) => {
    const listener = (_e: unknown, msg: { ptyId: string; token: string; exitCode: number }) => cb(msg);
    ipcRenderer.on("pty.exit", listener as never);
    return () => ipcRenderer.removeListener("pty.exit", listener as never);
  },
  minimizeWindow: () => ipcRenderer.send("win.minimize"),
  toggleMaximizeWindow: () => ipcRenderer.send("win.toggle-maximize"),
  closeWindow: () => ipcRenderer.send("win.close"),
  isWindowMaximized: () => ipcRenderer.invoke("win.is-maximized"),
  onWindowMaximized: (cb) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on("win.maximized", listener as never);
    return () => ipcRenderer.removeListener("win.maximized", listener as never);
  },
  zoomIn: () => ipcRenderer.send("win.zoom-in"),
  zoomOut: () => ipcRenderer.send("win.zoom-out"),
  zoomReset: () => ipcRenderer.send("win.zoom-reset"),
  getTerminalFont: () => ipcRenderer.invoke("term.font"),
  pickProjectDir: () => ipcRenderer.invoke("projects.pick"),
  openPath: (path: string) => ipcRenderer.invoke("shell.openPath", { path }),
  openExternal: (url: string) => ipcRenderer.invoke("shell.openExternal", { url }),
  openHtml: (name: string, html: string) => ipcRenderer.invoke("shell.openHtml", { name, html })
};

contextBridge.exposeInMainWorld("cw", api);
