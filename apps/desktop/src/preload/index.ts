import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings } from "@cw-code/contracts";

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

export interface GitStatus {
  branch: string;
  dirtyCount: number;
  worktreeName: string;
  prNumber: number | null;
  clean: boolean;
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
  isDev: boolean;
  openHarnessTrace(): Promise<{ ok: boolean; path?: string; error?: string }>;
  listProjects(): Promise<Array<{ id: string; rootPath: string; name: string }>>;
  addProject(rootPath: string): Promise<{ id: string; rootPath: string; name: string }>;
  listSessions(projectId: string): Promise<unknown[]>;
  listDiscovered(projectId: string): Promise<unknown[]>;
  importSession(projectId: string, driver: DriverName, resumeCursor: string, title: string): Promise<unknown>;
  createSession(projectId: string, driver: DriverName): Promise<unknown>;
  renameSession(sessionId: string, title: string): Promise<void>;
  getHistory(sessionId: string): Promise<unknown[]>;
  startTurn(sessionId: string, prompt: string, opts?: { prefs?: ComposerPrefs; attachments?: string[] }): Promise<string>;
  interrupt(turnId: string): Promise<void>;
  respondApproval(requestId: string, decision: "accept" | "acceptForSession" | "acceptGlobal" | "decline" | "cancel"): Promise<void>;
  respondQuestion(requestId: string, answers: Record<string, string>): Promise<void>;
  listModels(sessionId: string): Promise<ModelOption[]>;
  listModelsFor(projectId: string, driver: DriverName): Promise<ModelOption[]>;
  getComposer(sessionId: string): Promise<ComposerPrefs>;
  setComposer(sessionId: string, prefs: ComposerPrefs): Promise<ComposerPrefs>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  getGitStatus(sessionId: string): Promise<GitStatus>;
  onTurnEvent(cb: (event: unknown) => void): () => void;
  readFile(sessionId: string, path: string): Promise<string>;
  readOutsideFile(path: string): Promise<string>;
  saveFile(sessionId: string, path: string, content: string): Promise<void>;
  listFiles(sessionId: string): Promise<string[]>;
  listProjectFiles(projectId: string): Promise<string[]>;
  savePasteImage(projectId: string, mime: string, data: Uint8Array): Promise<string>;
  readImage(args: { sessionId?: string; projectId?: string; path: string }): Promise<{ mime: string; base64: string }>;
  turnDiff(sessionId: string, since: number): Promise<string>;
  openPty(sessionId: string, kind: PtyKindName): Promise<string>;
  writePty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number): void;
  killPty(ptyId: string): void;
  onPtyData(cb: (msg: { ptyId: string; data: string }) => void): () => void;
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
  openHtml(name: string, html: string): Promise<void>;
}

const api: CwApi = {
  checkVersions: () => ipcRenderer.invoke("cli.checkVersions"),
  isDev: Boolean(process.env["ELECTRON_RENDERER_URL"]),
  openHarnessTrace: () => ipcRenderer.invoke("debug.openTrace"),
  listProjects: () => ipcRenderer.invoke("projects.list"),
  addProject: (rootPath: string) => ipcRenderer.invoke("projects.add", rootPath),
  listSessions: (projectId: string) => ipcRenderer.invoke("sessions.list", projectId),
  listDiscovered: (projectId: string) => ipcRenderer.invoke("sessions.discovered", projectId),
  importSession: (projectId: string, driver: DriverName, resumeCursor: string, title: string) =>
    ipcRenderer.invoke("sessions.import", { projectId, driver, resumeCursor, title }),
  createSession: (projectId: string, driver: DriverName) =>
    ipcRenderer.invoke("sessions.create", { projectId, driver }),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke("sessions.rename", { sessionId, title }),
  getHistory: (sessionId: string) => ipcRenderer.invoke("sessions.history", { sessionId }),
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
  getComposer: (sessionId: string) => ipcRenderer.invoke("composer.get", { sessionId }),
  setComposer: (sessionId: string, prefs: ComposerPrefs) =>
    ipcRenderer.invoke("composer.set", { sessionId, prefs }),
  getSettings: () => ipcRenderer.invoke("settings.get"),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke("settings.set", patch),
  getGitStatus: (sessionId: string) => ipcRenderer.invoke("git.status", { sessionId }),
  onTurnEvent: (cb) => {
    const listener = (_e: unknown, event: unknown) => cb(event);
    ipcRenderer.on("turn.event", listener as never);
    return () => ipcRenderer.removeListener("turn.event", listener as never);
  },
  readFile: (sessionId: string, path: string) => ipcRenderer.invoke("fs.readFile", { sessionId, path }),
  readOutsideFile: (path: string) => ipcRenderer.invoke("fs.readOutsideFile", { path }),
  saveFile: (sessionId: string, path: string, content: string) =>
    ipcRenderer.invoke("fs.saveFile", { sessionId, path, content }),
  listFiles: (sessionId: string) => ipcRenderer.invoke("fs.listFiles", { sessionId }),
  listProjectFiles: (projectId: string) => ipcRenderer.invoke("fs.listProjectFiles", { projectId }),
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
  killPty: (ptyId: string) => ipcRenderer.send("pty.kill", { ptyId }),
  onPtyData: (cb) => {
    const listener = (_e: unknown, msg: { ptyId: string; data: string }) => cb(msg);
    ipcRenderer.on("pty.data", listener as never);
    return () => ipcRenderer.removeListener("pty.data", listener as never);
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
  openHtml: (name: string, html: string) => ipcRenderer.invoke("shell.openHtml", { name, html })
};

contextBridge.exposeInMainWorld("cw", api);
