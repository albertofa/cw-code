import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings, CliBinary, CliDiscoveredCandidate, CliDiscoverResult, CreateSessionOptions, GitBranchInfo, GitDiffMode, GitDiffResult, GitStatus, HarnessId, Project, RetryConnectionResult, SessionCleanupResult, SessionMeta, SessionStatus, SkillDetail, SkillMeta, SkillSaveInput, SkillsListResult, SourceControlHealth, SubagentToolsResult, WorktreePruneSummary } from "@cw-code/contracts";

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

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export type DriverName = "claude" | "opencode" | "codex";
export type PtyKindName = DriverName | "shell";

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
  startTurn(sessionId: string, prompt: string, opts?: { prefs?: ComposerPrefs; attachments?: string[] }): Promise<string>;
  interrupt(turnId: string): Promise<void>;
  respondApproval(requestId: string, decision: "accept" | "acceptForSession" | "acceptGlobal" | "decline" | "cancel"): Promise<void>;
  respondQuestion(requestId: string, answers: Record<string, string>): Promise<void>;
  listModels(sessionId: string): Promise<ModelOption[]>;
  listModelsFor(projectId: string, driver: DriverName): Promise<ModelOption[]>;
  listModelsForHarness(driver: DriverName): Promise<ModelOption[]>;
  getComposer(sessionId: string): Promise<ComposerPrefs>;
  setComposer(sessionId: string, prefs: ComposerPrefs): Promise<ComposerPrefs>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  skills: {
    list(): Promise<SkillsListResult>;
    get(name: string): Promise<SkillDetail>;
    save(input: SkillSaveInput): Promise<SkillDetail>;
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
  onTurnEvent(cb: (event: unknown) => void): () => void;
  onSessionTitle(cb: (msg: { sessionId: string; title: string }) => void): () => void;
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
  checkVersions: () => ipcRenderer.invoke("cli.checkVersions"),
  discoverBinaries: (binaries?: CliBinary[]) => ipcRenderer.invoke("cli.discover", { binaries }),
  verifyBinaryPath: (binary: CliBinary, path: string) =>
    ipcRenderer.invoke("cli.verifyPath", { binary, path }),
  isDev: Boolean(process.env["ELECTRON_RENDERER_URL"]),
  openHarnessTrace: () => ipcRenderer.invoke("debug.openTrace"),
  listProjects: () => ipcRenderer.invoke("projects.list"),
  addProject: (rootPath: string) => ipcRenderer.invoke("projects.add", rootPath),
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
  startTurn: (sessionId: string, prompt: string, opts?: { prefs?: ComposerPrefs; attachments?: string[] }) =>
    ipcRenderer.invoke("turns.start", { sessionId, prompt, prefs: opts?.prefs, attachments: opts?.attachments }),
  interrupt: (turnId: string) => ipcRenderer.invoke("turns.interrupt", { turnId }),
  respondApproval: (requestId: string, decision: "accept" | "acceptForSession" | "acceptGlobal" | "decline" | "cancel") =>
    ipcRenderer.invoke("approvals.respond", { requestId, decision }),
  respondQuestion: (requestId: string, answers: Record<string, string>) =>
    ipcRenderer.invoke("questions.respond", { requestId, answers }),
  listModels: (sessionId: string) => ipcRenderer.invoke("models.list", { sessionId }),
  listModelsFor: (projectId: string, driver: DriverName) =>
    ipcRenderer.invoke("models.listFor", { projectId, driver }),
  listModelsForHarness: (driver: DriverName) =>
    ipcRenderer.invoke("models.listForHarness", { driver }),
  getComposer: (sessionId: string) => ipcRenderer.invoke("composer.get", { sessionId }),
  setComposer: (sessionId: string, prefs: ComposerPrefs) =>
    ipcRenderer.invoke("composer.set", { sessionId, prefs }),
  getSettings: () => ipcRenderer.invoke("settings.get"),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke("settings.set", patch),
  skills: {
    list: () => ipcRenderer.invoke("skills.list"),
    get: (name: string) => ipcRenderer.invoke("skills.get", name),
    save: (input: SkillSaveInput) => ipcRenderer.invoke("skills.save", input),
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
