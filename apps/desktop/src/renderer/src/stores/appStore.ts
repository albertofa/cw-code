import { create } from "zustand";
import type { CommandInvocation, SessionRow, SessionStatusReason, SidebarDefaults, ThreadItem } from "@cw-code/contracts";
import type {
  AppSettings,
  ApprovalDecision,
  ComposerPrefs,
  CreateSessionOptions,
  CustomTheme,
  DriverName,
  GitStatus,
  ImportSessionRequest,
  PrRef,
  Project,
  ProjectSettings,
  Session,
  SessionStatus,
  NotificationSoundSettings,
  SettingsPatch,
  ShutdownAssessment,
  ShutdownReason,
  SubagentToolsResult,
  UpdateActionResult,
  UpdateChannel,
  UpdateState
} from "../cw.js";
import type { DirtyBuffer } from "./editorBuffers.js";
import { usePanelStore } from "./panelStore.js";
import { DEFAULT_APPEARANCE, appearanceOf, type AppearancePrefs } from "../appearanceFonts.js";
import { getLastModel, pushRecentModel } from "../components/lastModel.js";
import { defaultModelPatch } from "../components/modelMenus.js";
import { fallbackHarness } from "../components/harnessAvailability.js";
import { projectDriver, withProjectPrefs } from "../components/projectDefaults.js";
import { useNotifs } from "../components/Notifications.js";
import { ipcErrorMessage } from "../components/ipcError.js";
import { currentCheckoutSessionIds } from "../components/sessionBranch.js";
import { sameItems, sessionsByProjectOf } from "../server/sidebarData.js";
import { isThreadBusy } from "../components/useThread.js";
import { useBranchStore } from "./branchStore.js";
import { shouldApplyUpdateState } from "./updateThrottle.js";

const GIT_REFRESH_BATCH = 6;
let lastUpdateAppliedAt = 0;
let pendingPromptInFlight = false;

export class NewSessionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewSessionRefusedError";
  }
}

interface GitStatusTracker {
  issued: number;
  applied: number;
  latest: Promise<void>;
}

const gitStatusTrackers = new Map<string, GitStatusTracker>();

async function refreshGitStatusInBatches(ids: string[], refresh: (id: string) => Promise<void>): Promise<void> {
  for (let i = 0; i < ids.length; i += GIT_REFRESH_BATCH) {
    await Promise.all(ids.slice(i, i + GIT_REFRESH_BATCH).map((id) => refresh(id)));
  }
}

export type ChatMessage = ThreadItem;

export const DEFAULT_COMPOSER: Required<Pick<ComposerPrefs, "effort" | "permissionMode">> & ComposerPrefs = {
  effort: "medium",
  permissionMode: "auto"
};

const composerLoads = new Map<string, Promise<void>>();
const SESSION_ROW_WAIT_MS = 5000;
const SESSION_ROW_LATE_MS = 60_000;

function defaultWorkspace(defaultUseWorktree: boolean): CreateSessionOptions {
  return { mode: defaultUseWorktree ? "new" : "current" };
}

function sessionOwnerId(byProject: Record<string, Session[]>, sessionId: string | null): string | undefined {
  if (!sessionId) return undefined;
  return Object.entries(byProject).find(([, list]) => list.some((s) => s.id === sessionId))?.[0];
}

function recentProjectId(state: { projects: Project[]; projectsByRecency: string[] }): string | null {
  const known = new Set(state.projects.map((p) => p.id));
  return state.projectsByRecency.find((id) => known.has(id)) ?? state.projects[0]?.id ?? null;
}

function hasSession(byProject: Record<string, Session[]>, sessionId: string): boolean {
  return sessionOwnerId(byProject, sessionId) !== undefined;
}

function waitForSession(sessionId: string, timeoutMs = SESSION_ROW_WAIT_MS): Promise<boolean> {
  if (hasSession(useAppStore.getState().sessionsByProject, sessionId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (appeared: boolean): void => {
      window.clearTimeout(timer);
      stop();
      resolve(appeared);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    const stop = useAppStore.subscribe((state) => {
      if (hasSession(state.sessionsByProject, sessionId)) finish(true);
    });
  });
}

async function selectWhenListed(sessionId: string, select: () => void): Promise<void> {
  const selectedBefore = useAppStore.getState().activeSessionId;
  if (await waitForSession(sessionId)) {
    select();
    return;
  }
  useNotifs.getState().push({
    kind: "warning",
    title: "Session not listed yet",
    message: "The new session didn't appear yet — it will show up in the sidebar when ready."
  });
  void waitForSession(sessionId, SESSION_ROW_LATE_MS).then((appeared) => {
    if (appeared && useAppStore.getState().activeSessionId === selectedBefore) select();
  });
}

function withProject(projects: Project[], project: Project): Project[] {
  return projects.some((p) => p.id === project.id)
    ? projects.map((p) => (p.id === project.id ? project : p))
    : [...projects, project];
}

function reasoningExpandedFrom(settings: AppSettings): Record<DriverName, boolean> {
  return {
    claude: settings.claudeReasoningExpanded,
    opencode: settings.opencodeReasoningExpanded,
    codex: settings.codexReasoningExpanded
  };
}

function defaultModelsFrom(settings: AppSettings): Record<DriverName, string> {
  return {
    claude: settings.claudeDefaultModel,
    opencode: settings.opencodeDefaultModel,
    codex: settings.codexDefaultModel
  };
}

export type ShutdownPhase = "review" | "waiting" | "saving" | "preparing" | "timeout";

export interface ShutdownUiState {
  reason: ShutdownReason;
  assessment: ShutdownAssessment;
  dirty: DirtyBuffer[];
  phase: ShutdownPhase;
  error: string | null;
  pending: string[];
}

export interface SendPromptOptions {
  prRefs?: PrRef[];
  command?: CommandInvocation;
  skills?: string[];
  acceptFolderHead?: string;
}

export type ComposerSendOptions = Pick<SendPromptOptions, "command" | "skills">;

export interface ThemePreview {
  themeId: string;
  customThemes: CustomTheme[];
}

interface AppState {
  shutdown: ShutdownUiState | null;
  projects: Project[];
  sessionsByProject: Record<string, Session[]>;
  activeProjectId: string | null;
  activeSessionId: string | null;
  composerBySession: Record<string, ComposerPrefs>;
  composerLoadedBySession: Record<string, boolean>;
  pendingDriver: DriverName | null;
  lastDriver: DriverName;
  installedHarnesses: DriverName[] | null;
  pendingPrefs: ComposerPrefs;
  pendingWorkspace: CreateSessionOptions;
  newSessionError: string | null;
  setPendingPrefs(prefs: ComposerPrefs): void;
  setPendingWorkspace(options: CreateSessionOptions): void;
  gitStatusBySession: Record<string, GitStatus>;
  refreshGitStatus(sessionId: string): Promise<void>;
  applyGitStatus(sessionId: string, status: GitStatus): void;
  refreshProjectCheckoutGitStatus(sessionId: string): Promise<void>;
  sourceControlRefreshIntervalSeconds: number;
  prRefreshIntervalSeconds: number;
  defaultUseWorktree: boolean;
  appearance: AppearancePrefs;
  themePreview: ThemePreview | null;
  setThemePreview(preview: ThemePreview | null): void;
  notificationSounds: NotificationSoundSettings | null;
  reasoningExpandedByDriver: Record<DriverName, boolean>;
  defaultModelByDriver: Record<DriverName, string>;
  previewBySession: Record<string, { sessionId: string; path: string; basePath: string }>;
  openPreview(sessionId: string, path: string, basePath: string): void;
  closePreview(sessionId: string): void;
  homeDir: string | null;
  sidebarLoaded: boolean;
  projectsByRecency: string[];
  applySidebar(projects: Project[], rows: SessionRow[], defaults: SidebarDefaults | null): void;
  addProject(rootPath: string): Promise<void>;
  addProjectForNewSession(rootPath: string): Promise<void>;
  setPendingProject(projectId: string): void;
  selectSession(sessionId: string): void;
  startNewSession(driver?: DriverName): void;
  setPendingDriver(driver: DriverName): void;
  sendPendingPrompt(prompt: string, attachments?: string[], opts?: ComposerSendOptions): Promise<void>;
  subagentToolsByKey: Record<string, SubagentToolsResult>;
  subagentToolsLoading: Record<string, boolean>;
  loadSubagentTools(sessionId: string, agentId: string): Promise<void>;
  ensureComposer(sessionId: string): Promise<void>;
  setComposerPrefs(sessionId: string, prefs: ComposerPrefs): Promise<void>;
  settingsLoaded: boolean;
  saveSettings(patch: SettingsPatch): Promise<AppSettings>;
  saveDefaultModel(driver: DriverName, id: string): Promise<void>;
  setProjectGitHubAccount(projectId: string, account: { host: string; login: string } | null): Promise<void>;
  updateProjectSettings(projectId: string, settings: ProjectSettings): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  regenerateSessionTitle(sessionId: string): Promise<void>;
  setSessionStatus(sessionId: string, status: SessionStatus, reason?: SessionStatusReason): Promise<void>;
  markSessionWorking(sessionId: string): Promise<void>;
  restoreSession(sessionId: string): Promise<void>;
  createSession(driver: DriverName, prefs?: ComposerPrefs, workspace?: CreateSessionOptions): Promise<void>;
  createSessionIn(projectId: string, driver: DriverName, prefs?: ComposerPrefs, workspace?: CreateSessionOptions): Promise<Session>;
  importSession(request: ImportSessionRequest): Promise<Session>;
  applyProject(project: Project): void;
  applySettings(saved: AppSettings): void;
  applyComposer(sessionId: string, prefs: ComposerPrefs): void;
  sendPrompt(prompt: string, attachments?: string[], opts?: ComposerSendOptions): Promise<void>;
  sendPromptTo(sessionId: string, prompt: string, attachments?: string[], opts?: SendPromptOptions): Promise<void>;
  interrupt(): Promise<void>;
  retryConnection(sessionId: string): Promise<void>;
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  respondQuestion(requestId: string, answers: Record<string, string>): Promise<void>;
  updates: UpdateState | null;
  subscribeUpdates(): () => void;
  applyUpdateState(state: UpdateState): void;
  checkForUpdates(): Promise<UpdateActionResult>;
  downloadUpdate(): Promise<UpdateActionResult>;
  setUpdateChannel(channel: UpdateChannel): Promise<UpdateActionResult>;
  setUpdateBackgroundDownload(enabled: boolean): Promise<AppSettings>;
  updateRestartPending: boolean;
}

async function answerPendingRequest(answer: Promise<void>): Promise<void> {
  try {
    await answer;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== "request-not-pending") throw err;
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  shutdown: null,
  projects: [],
  sessionsByProject: {},
  activeProjectId: null,
  activeSessionId: null,
  subagentToolsByKey: {},
  subagentToolsLoading: {},
  composerBySession: {},
  composerLoadedBySession: {},
  settingsLoaded: false,
  pendingDriver: null,
  lastDriver: "claude",
  installedHarnesses: null,
  pendingPrefs: { ...DEFAULT_COMPOSER },
  pendingWorkspace: defaultWorkspace(true),
  newSessionError: null,
  gitStatusBySession: {},
  sourceControlRefreshIntervalSeconds: 30,
  prRefreshIntervalSeconds: 120,
  defaultUseWorktree: true,
  appearance: DEFAULT_APPEARANCE,
  themePreview: null,
  notificationSounds: null,
  reasoningExpandedByDriver: { claude: false, opencode: false, codex: false },
  defaultModelByDriver: { claude: "", opencode: "", codex: "" },
  updates: null,
  updateRestartPending: false,

  subscribeUpdates() {
    const off = window.cw.updates.onChanged((state) => get().applyUpdateState(state));
    window.cw.updates
      .getState()
      .then((state) => get().applyUpdateState(state))
      .catch((err: unknown) => console.warn(`update state unavailable: ${ipcErrorMessage(err)}`));
    return off;
  },

  applyUpdateState(state: UpdateState) {
    const now = Date.now();
    if (!shouldApplyUpdateState(get().updates, state, lastUpdateAppliedAt, now)) return;
    lastUpdateAppliedAt = now;
    set({ updates: state });
  },

  async checkForUpdates() {
    const result = await window.cw.updates.check();
    get().applyUpdateState(result.state);
    return result;
  },

  async downloadUpdate() {
    const result = await window.cw.updates.download();
    get().applyUpdateState(result.state);
    return result;
  },

  async setUpdateChannel(channel: UpdateChannel) {
    const result = await window.cw.updates.setChannel(channel);
    get().applyUpdateState(result.state);
    return result;
  },

  setUpdateBackgroundDownload(enabled: boolean) {
    return window.cw.setSettings({ updateBackgroundDownload: enabled });
  },

  setPendingPrefs(prefs: ComposerPrefs) {
    set({ pendingPrefs: { ...get().pendingPrefs, ...prefs } });
  },

  setPendingWorkspace(options: CreateSessionOptions) {
    set({ pendingWorkspace: { ...get().pendingWorkspace, ...options }, newSessionError: null });
  },

  applyGitStatus(sessionId: string, status: GitStatus) {
    const tracker = gitStatusTrackers.get(sessionId);
    if (tracker) tracker.applied = tracker.issued;
    set({ gitStatusBySession: { ...get().gitStatusBySession, [sessionId]: status } });
    useBranchStore.getState().reconcileKeptHead(sessionId, status);
  },

  async refreshGitStatus(sessionId: string) {
    const tracker = gitStatusTrackers.get(sessionId) ?? { issued: 0, applied: 0, latest: Promise.resolve() };
    const sequence = tracker.issued + 1;
    const run = (async () => {
      try {
        const status = await window.cw.getGitStatus(sessionId);
        if (sequence <= tracker.applied) return;
        tracker.applied = sequence;
        set({ gitStatusBySession: { ...get().gitStatusBySession, [sessionId]: status } });
        useBranchStore.getState().reconcileKeptHead(sessionId, status);
      } catch (err) {
        console.warn(`git status refresh failed for ${sessionId}: ${ipcErrorMessage(err)}`);
      }
    })();
    tracker.issued = sequence;
    tracker.latest = run;
    gitStatusTrackers.set(sessionId, tracker);
    await run;
    if (tracker.issued !== sequence) await tracker.latest;
  },

  async refreshProjectCheckoutGitStatus(sessionId: string) {
    const session = Object.values(get().sessionsByProject)
      .flat()
      .find((item) => item.id === sessionId);
    const siblings = session && !session.worktreePath
      ? currentCheckoutSessionIds(get().sessionsByProject[session.projectId] ?? []).filter((id) => id !== sessionId)
      : [];
    void refreshGitStatusInBatches(siblings, (id) => get().refreshGitStatus(id));
    await get().refreshGitStatus(sessionId);
  },

  previewBySession: {},

  homeDir: null,

  sidebarLoaded: false,
  projectsByRecency: [],

  openPreview(sessionId: string, path: string, basePath: string) {
    set((state) => ({
      previewBySession: {
        ...state.previewBySession,
        [sessionId]: { sessionId, path, basePath }
      }
    }));
  },

  setThemePreview(preview: ThemePreview | null) {
    set({ themePreview: preview });
  },

  closePreview(sessionId: string) {
    set((state) => {
      if (!state.previewBySession[sessionId]) return state;
      const previewBySession = { ...state.previewBySession };
      delete previewBySession[sessionId];
      return { previewBySession };
    });
  },

  applySidebar(projects: Project[], rows: SessionRow[], defaults: SidebarDefaults | null) {
    const current = get();
    const nextProjects = sameItems(current.projects, projects) ? current.projects : projects;
    const sessionsByProject = sessionsByProjectOf(projects, rows, current.sessionsByProject);
    const projectsByRecency =
      defaults && !sameItems(current.projectsByRecency, defaults.projectsByRecency) ? defaults.projectsByRecency : current.projectsByRecency;
    if (nextProjects !== current.projects || sessionsByProject !== current.sessionsByProject || projectsByRecency !== current.projectsByRecency) {
      set({ projects: nextProjects, sessionsByProject, projectsByRecency });
    }
    if (current.sidebarLoaded || !defaults) return;
    if (projects.length === 0 && !defaults.restoreSessionId) return;
    set({ sidebarLoaded: true });
    if (get().activeProjectId) return;
    const picked = defaults.restoreSessionId ? rows.find((row) => row.session.id === defaults.restoreSessionId)?.session : undefined;
    if (!picked) {
      const projectId = defaults.restoreProjectId ?? projects[0]?.id;
      if (projectId) set({ activeProjectId: projectId, activeSessionId: null, pendingDriver: get().lastDriver });
      return;
    }
    set({ activeProjectId: picked.projectId, activeSessionId: picked.id, pendingDriver: null });
    if (picked.status === "done") {
      void window.cw.openSession(picked.id, "restore").catch((err: Error) =>
        console.warn(`openSession failed for ${picked.id}: ${err.message}`)
      );
    }
    void get().ensureComposer(picked.id);
    void get().refreshGitStatus(picked.id);
  },

  async addProject(rootPath: string) {
    const project = await window.cw.addProject(rootPath);
    set({ projects: withProject(get().projects, project) });
    if (!get().activeProjectId) get().setPendingProject(project.id);
  },

  async addProjectForNewSession(rootPath: string) {
    const project = await window.cw.addProject(rootPath);
    set({ projects: withProject(get().projects, project) });
    get().setPendingProject(project.id);
  },

  setPendingProject(projectId: string) {
    const pendingDriver = get().pendingDriver;
    const settings = get().projects.find((p) => p.id === projectId)?.settings;
    const target = pendingDriver === null ? null : fallbackHarness(projectDriver(settings, pendingDriver), get().installedHarnesses);
    set({
      activeProjectId: projectId,
      activeSessionId: null,
      pendingWorkspace: defaultWorkspace(get().defaultUseWorktree),
      newSessionError: null,
      ...(pendingDriver !== null && target !== null
        ? { pendingDriver: target, pendingPrefs: withProjectPrefs(get().pendingPrefs, settings, target, target !== pendingDriver) }
        : {})
    });
  },

  async renameSession(sessionId: string, title: string) {
    const name = title.trim();
    if (!name) return;
    await window.cw.renameSession(sessionId, name);
  },

  async regenerateSessionTitle(sessionId: string) {
    await window.cw.regenerateSessionTitle(sessionId);
  },

  async setSessionStatus(sessionId: string, status: SessionStatus, reason?: SessionStatusReason) {
    if (status !== "resolved" && status !== "archived") {
      await window.cw.setSessionStatus(sessionId, status, reason);
      return;
    }
    const result = await window.cw.resolveSession(sessionId, status, true, false);
    if (get().activeSessionId === sessionId) return;
    if (result.destroyScriptError) {
      useNotifs.getState().push({ kind: "error", title: "Destroy script failed", message: result.destroyScriptError });
    }
    if (result.error && !result.dirtyBlocked) {
      useNotifs.getState().push({ kind: "error", title: "Could not prune worktree", message: result.error });
    }
  },

  async markSessionWorking(sessionId: string) {
    await window.cw.markSessionWorking(sessionId);
  },

  async restoreSession(sessionId: string) {
    await window.cw.restoreSession(sessionId);
  },

  selectSession(sessionId: string) {
    const ownerId = sessionOwnerId(get().sessionsByProject, sessionId);
    set({
      activeSessionId: sessionId,
      pendingDriver: null,
      ...(ownerId && ownerId !== get().activeProjectId ? { activeProjectId: ownerId } : {})
    });
    void get().ensureComposer(sessionId);
    void get().refreshGitStatus(sessionId);
  },

  startNewSession(driver?: DriverName) {
    const currentProjectId = get().activeProjectId;
    const projectId = currentProjectId ?? sessionOwnerId(get().sessionsByProject, get().activeSessionId) ?? recentProjectId(get());
    const settings = projectId ? get().projects.find((p) => p.id === projectId)?.settings : undefined;
    const target = fallbackHarness(driver ?? projectDriver(settings, get().lastDriver), get().installedHarnesses);
    const previous = get().pendingDriver ?? get().lastDriver;
    const currentModel = get().pendingPrefs.model;
    if (currentModel && previous !== target) pushRecentModel(previous, currentModel);
    set({
      pendingDriver: target,
      activeSessionId: null,
      pendingWorkspace: defaultWorkspace(get().defaultUseWorktree),
      newSessionError: null,
      pendingPrefs: withProjectPrefs(get().pendingPrefs, settings, target, true)
    });
    if (projectId && projectId !== currentProjectId) get().setPendingProject(projectId);
  },

  setPendingDriver(driver: DriverName) {
    const current = get().pendingDriver ?? get().lastDriver;
    if (current === driver && get().pendingDriver !== null) return;
    const currentModel = get().pendingPrefs.model;
    if (currentModel) pushRecentModel(current, currentModel);
    set({ pendingDriver: driver, pendingPrefs: { ...get().pendingPrefs, model: undefined } });
  },

  async sendPendingPrompt(prompt: string, attachments: string[] = [], opts?: ComposerSendOptions) {
    const projectId = get().activeProjectId;
    const driver = get().pendingDriver ?? get().lastDriver;
    const pendingPrefs = get().pendingPrefs;
    const prefs = pendingPrefs.model
      ? pendingPrefs
      : { ...pendingPrefs, model: get().defaultModelByDriver[driver] || getLastModel(driver) || undefined };
    const workspace = get().pendingWorkspace;
    if (!projectId || (!prompt.trim() && attachments.length === 0)) return;
    if (pendingPromptInFlight) return;
    pendingPromptInFlight = true;
    set({ newSessionError: null });
    try {
      try {
        await get().createSession(driver, prefs, workspace);
      } catch (err) {
        const message = ipcErrorMessage(err);
        set({ newSessionError: message });
        throw new NewSessionRefusedError(message);
      }
      await get().sendPrompt(prompt, attachments, opts);
    } finally {
      pendingPromptInFlight = false;
    }
  },

  async loadSubagentTools(sessionId: string, agentId: string) {
    const key = `${sessionId}:${agentId}`;
    if (get().subagentToolsByKey[key] || get().subagentToolsLoading[key]) return;
    set({ subagentToolsLoading: { ...get().subagentToolsLoading, [key]: true } });
    try {
      const result = await window.cw.getSubagentTools(sessionId, agentId);
      const hasData =
        result.items.length > 0 ||
        result.model !== undefined ||
        result.effort !== undefined ||
        result.tokens !== undefined;
      if (hasData) {
        set({ subagentToolsByKey: { ...get().subagentToolsByKey, [key]: result } });
      }
    } catch (err) {
      useNotifs.getState().push({
        kind: "error",
        title: "Could not load subagent tools",
        message: (err as Error).message
      });
    } finally {
      const loading = { ...get().subagentToolsLoading };
      delete loading[key];
      set({ subagentToolsLoading: loading });
    }
  },

  async ensureComposer(sessionId: string) {
    const inflight = composerLoads.get(sessionId);
    if (inflight) return inflight;
    if (get().composerBySession[sessionId]) return;
    set({ composerBySession: { ...get().composerBySession, [sessionId]: { ...DEFAULT_COMPOSER } } });
    const load = (async () => {
      try {
        get().applyComposer(sessionId, await window.cw.getComposer(sessionId));
      } catch {
      } finally {
        composerLoads.delete(sessionId);
      }
    })();
    composerLoads.set(sessionId, load);
    return load;
  },

  async setComposerPrefs(sessionId: string, prefs: ComposerPrefs) {
    await composerLoads.get(sessionId);
    const merged = { ...(get().composerBySession[sessionId] ?? DEFAULT_COMPOSER), ...prefs };
    set({ composerBySession: { ...get().composerBySession, [sessionId]: merged } });
    try {
      const saved = await window.cw.setComposer(sessionId, merged);
      set({ composerBySession: { ...get().composerBySession, [sessionId]: { ...DEFAULT_COMPOSER, ...saved } } });
    } catch {
    }
  },

  async saveSettings(patch: SettingsPatch) {
    const saved = await window.cw.setSettings(patch);
    get().applySettings(saved);
    return saved;
  },

  applySettings(saved: AppSettings) {
    const first = !get().settingsLoaded;
    set({
      ...(first ? { pendingWorkspace: { ...get().pendingWorkspace, ...defaultWorkspace(saved.defaultUseWorktree) } } : {}),
      sourceControlRefreshIntervalSeconds: saved.sourceControlRefreshIntervalSeconds,
      prRefreshIntervalSeconds: saved.prRefreshIntervalSeconds,
      defaultUseWorktree: saved.defaultUseWorktree,
      settingsLoaded: true,
      appearance: appearanceOf(saved),
      notificationSounds: saved.notificationSounds,
      reasoningExpandedByDriver: reasoningExpandedFrom(saved),
      defaultModelByDriver: defaultModelsFrom(saved)
    });
  },

  applyComposer(sessionId: string, prefs: ComposerPrefs) {
    set({
      composerBySession: { ...get().composerBySession, [sessionId]: { ...DEFAULT_COMPOSER, ...prefs } },
      composerLoadedBySession: { ...get().composerLoadedBySession, [sessionId]: true }
    });
  },

  async saveDefaultModel(driver: DriverName, id: string) {
    const saved = await window.cw.setSettings(defaultModelPatch(driver, id));
    set({ defaultModelByDriver: defaultModelsFrom(saved) });
  },

  async setProjectGitHubAccount(projectId: string, account: { host: string; login: string } | null) {
    const updated = await window.cw.setProjectGitHubAccount(projectId, account);
    set({ projects: get().projects.map((project) => project.id === projectId ? updated : project) });
    const ids = (get().sessionsByProject[projectId] ?? []).map((session) => session.id);
    void refreshGitStatusInBatches(ids, (id) => get().refreshGitStatus(id));
  },

  async updateProjectSettings(projectId: string, settings: ProjectSettings) {
    const updated = await window.cw.updateProjectSettings(projectId, settings);
    set({ projects: withProject(get().projects, updated) });
  },

  async createSession(driver: DriverName, prefs?: ComposerPrefs, workspace?: CreateSessionOptions) {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    await get().createSessionIn(projectId, driver, prefs, workspace);
  },

  async createSessionIn(projectId: string, driver: DriverName, prefs?: ComposerPrefs, workspace?: CreateSessionOptions) {
    const { createNotice, ...session } = await window.cw.createSession(projectId, driver, workspace);
    if (createNotice) {
      useNotifs.getState().push({ kind: "warning", title: "Session base", message: createNotice, sticky: true });
    }
    if (
      workspace?.mode === "previous" &&
      workspace.reuseWorktreePath &&
      session.worktreePath &&
      session.worktreePath !== workspace.reuseWorktreePath
    ) {
      const requested = workspace.reuseWorktreePath;
      const stillHeld = (get().sessionsByProject[projectId] ?? []).some((s) => s.worktreePath === requested);
      useNotifs.getState().push({
        kind: "warning",
        title: "Created a new worktree instead",
        ...(stillHeld ? {} : { message: "The requested worktree no longer exists." })
      });
    }
    set({ lastDriver: driver });
    await selectWhenListed(session.id, () => set({ activeProjectId: projectId, activeSessionId: session.id, pendingDriver: null }));
    await get().ensureComposer(session.id);
    if (prefs) await get().setComposerPrefs(session.id, { ...prefs });
    void get().refreshProjectCheckoutGitStatus(session.id);
    return session;
  },

  async importSession(request: ImportSessionRequest) {
    const { project, session } = await window.cw.importSession(request);
    set({ projects: withProject(get().projects, project) });
    await selectWhenListed(session.id, () => {
      set({ activeProjectId: project.id });
      get().selectSession(session.id);
    });
    return session;
  },

  applyProject(project: Project) {
    set({ projects: withProject(get().projects, project) });
  },

  async sendPrompt(prompt: string, attachments?: string[], opts?: ComposerSendOptions) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await get().sendPromptTo(sessionId, prompt, attachments, opts);
  },

  async sendPromptTo(sessionId: string, prompt: string, attachments?: string[], opts?: SendPromptOptions) {
    if (!prompt.trim()) return;
    const prefs = get().composerBySession[sessionId] ?? DEFAULT_COMPOSER;
    const acceptFolderHead = opts?.acceptFolderHead ?? useBranchStore.getState().keptFolderHeadBySession[sessionId];
    await window.cw.startTurn(sessionId, prompt, {
      prefs,
      attachments,
      ...(opts?.command ? { command: opts.command } : {}),
      ...(opts?.skills?.length ? { skills: opts.skills } : {}),
      ...(opts?.prRefs ? { prRefs: opts.prRefs } : {}),
      ...(acceptFolderHead ? { acceptFolderHead } : {})
    });
  },

  async interrupt() {
    const sessionId = get().activeSessionId;
    if (!sessionId || !isThreadBusy(sessionId)) return;
    try {
      await window.cw.stopTurn(sessionId);
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title: "Could not stop the turn", message: ipcErrorMessage(err) });
    }
  },

  async retryConnection(sessionId: string) {
    try {
      await window.cw.retryConnection(sessionId);
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title: "Could not reconnect", message: ipcErrorMessage(err) });
    }
  },

  async respondApproval(requestId: string, decision: ApprovalDecision) {
    await answerPendingRequest(window.cw.respondApproval(requestId, decision));
  },

  async respondQuestion(requestId: string, answers: Record<string, string>) {
    await answerPendingRequest(window.cw.respondQuestion(requestId, answers));
  }
}));

useAppStore.subscribe((state, previous) => {
  if (state.activeSessionId === previous.activeSessionId) return;
  const panels = usePanelStore.getState();
  panels.clearStaleDiffModeRequest(state.activeSessionId);
  panels.clearStaleRevealRequest(state.activeSessionId);
});
