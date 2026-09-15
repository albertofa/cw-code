import { create } from "zustand";
import type {
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  ComposerPrefs,
  CreateSessionOptions,
  DriverName,
  HistoryMessage,
  GitStatus,
  Project,
  QuestionRequest,
  Session,
  SessionStatus,
  SettingsPatch,
  TurnEvent
} from "../cw.js";
import { appendAssistantText } from "../components/chatMessages.js";
import { mergeToolPairs } from "../components/toolSummaries.js";
import { expiredHoldingIds } from "../components/workingSet.js";
import { useNotifs } from "../components/Notifications.js";

const GIT_REFRESH_BATCH = 6;

async function refreshGitStatusInBatches(ids: string[], refresh: (id: string) => Promise<void>): Promise<void> {
  for (let i = 0; i < ids.length; i += GIT_REFRESH_BATCH) {
    await Promise.all(ids.slice(i, i + GIT_REFRESH_BATCH).map((id) => refresh(id)));
  }
}

export interface ChatMessage extends HistoryMessage {
  toolInput?: unknown;
  toolOutput?: string;
  toolDone?: boolean;
  toolStartedAt?: number;
  toolCompletedAt?: number;
}

export const DEFAULT_COMPOSER: Required<Pick<ComposerPrefs, "effort" | "permissionMode">> & ComposerPrefs = {
  effort: "medium",
  permissionMode: "auto"
};

function defaultWorkspace(defaultUseWorktree: boolean): CreateSessionOptions {
  return { mode: defaultUseWorktree ? "new" : "current" };
}

function readComposerMirror(sessionId: string): ComposerPrefs | null {
  try {
    const raw = window.localStorage.getItem(`cw:composer:${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw) as ComposerPrefs;
  } catch {
    return null;
  }
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  numTurns: number;
}

interface AppState {
  projects: Project[];
  sessionsByProject: Record<string, Session[]>;
  discoveredByProject: Record<string, Session[]>;
  activeProjectId: string | null;
  projectFilter: string | "all";
  activeSessionId: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  usageBySession: Record<string, Usage>;
  busyTurns: Record<string, string>;
  loadingHistory: Record<string, boolean>;
  historyErrorBySession: Record<string, string>;
  turnStartedAt: Record<string, number>;
  lastTurnStats: Record<string, { ms: number }>;
  composerBySession: Record<string, ComposerPrefs>;
  pendingDriver: DriverName | null;
  lastDriver: DriverName;
  pendingApprovals: Record<string, ApprovalRequest[]>;
  pendingQuestions: Record<string, QuestionRequest[]>;
  pendingPrefs: ComposerPrefs;
  pendingWorkspace: CreateSessionOptions;
  setProjectFilter(filter: string | "all"): void;
  setPendingPrefs(prefs: ComposerPrefs): void;
  setPendingWorkspace(options: CreateSessionOptions): void;
  gitStatusBySession: Record<string, GitStatus>;
  refreshGitStatus(sessionId: string): Promise<void>;
  sourceControlRefreshIntervalSeconds: number;
  holdingHours: number;
  defaultUseWorktree: boolean;
  preview: { sessionId: string; path: string; basePath: string } | null;
  openPreview(sessionId: string, path: string, basePath: string): void;
  closePreview(): void;
  loadProjects(): Promise<void>;
  addProject(rootPath: string): Promise<void>;
  selectProject(projectId: string): Promise<void>;
  selectSession(sessionId: string): void;
  startNewSession(driver?: DriverName): void;
  setPendingDriver(driver: DriverName): void;
  sendPendingPrompt(prompt: string, attachments?: string[]): Promise<void>;
  ensureHistory(sessionId: string, opts?: { force?: boolean; isRetry?: boolean }): Promise<void>;
  ensureComposer(sessionId: string): Promise<void>;
  setComposerPrefs(sessionId: string, prefs: ComposerPrefs): Promise<void>;
  settingsVersion: number;
  saveSettings(patch: SettingsPatch): Promise<AppSettings>;
  setProjectGitHubAccount(projectId: string, account: { host: string; login: string } | null): Promise<void>;
  loadDiscovered(): Promise<void>;
  importDiscovered(session: Session): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  regenerateSessionTitle(sessionId: string): Promise<void>;
  setSessionStatus(sessionId: string, status: SessionStatus, opts?: { promptWorktree?: boolean }): Promise<void>;
  expireHoldingSessions(): Promise<void>;
  worktreeConfirmQueue: Array<{ sessionId: string; status: SessionStatus; unmergedCommitCount?: number }>;
  confirmWorktreeRemoval(): Promise<void>;
  dismissWorktreeRemoval(): void;
  createSession(driver: DriverName, prefs?: ComposerPrefs, workspace?: CreateSessionOptions): Promise<void>;
  sendPrompt(prompt: string, attachments?: string[]): Promise<void>;
  interrupt(): Promise<void>;
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  respondQuestion(sessionId: string, requestId: string, answers: Record<string, string>): Promise<void>;
  applyEvent(sessionId: string, event: TurnEvent): void;
  applySessionTitle(sessionId: string, title: string): void;
}

function isSubagentToolName(name?: string): boolean {
  return !!name && (name.toLowerCase() === "task" || name.toLowerCase() === "agent");
}

function finalizeTurnTools(messages: ChatMessage[], turnId: string, backgroundTasks = 0): ChatMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "tool" || m.turnId !== turnId) return m;
    if (m.toolInput === undefined || m.toolDone === true || m.toolOutput !== undefined) return m;
    if (backgroundTasks > 0 && isSubagentToolName(m.toolName)) return m;
    changed = true;
    return { ...m, toolDone: true, toolCompletedAt: Date.now() };
  });
  return changed ? out : messages;
}

function withSessionStatus(
  byProject: Record<string, Session[]>,
  sessionId: string,
  status: SessionStatus
): Record<string, Session[]> {
  const next: Record<string, Session[]> = {};
  for (const [pid, list] of Object.entries(byProject)) {
    next[pid] = list.map((s) => (s.id === sessionId ? { ...s, status } : s));
  }
  return next;
}

function patchSession(
  byProject: Record<string, Session[]>,
  sessionId: string,
  patch: Partial<Session>
): Record<string, Session[]> {
  const next: Record<string, Session[]> = {};
  for (const [pid, list] of Object.entries(byProject)) {
    next[pid] = list.map((s) => (s.id === sessionId ? { ...s, ...patch } : s));
  }
  return next;
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  sessionsByProject: {},
  discoveredByProject: {},
  activeProjectId: null,
  projectFilter: "all",
  activeSessionId: null,
  messagesBySession: {},
  usageBySession: {},
  busyTurns: {},
  loadingHistory: {},
  historyErrorBySession: {},
  turnStartedAt: {},
  lastTurnStats: {},
  composerBySession: {},
  settingsVersion: 0,
  pendingDriver: null,
  lastDriver: "claude",
  pendingApprovals: {},
  pendingQuestions: {},
  worktreeConfirmQueue: [],
  pendingPrefs: { ...DEFAULT_COMPOSER },
  pendingWorkspace: defaultWorkspace(true),
  gitStatusBySession: {},
  sourceControlRefreshIntervalSeconds: 30,
  holdingHours: 6,
  defaultUseWorktree: true,

  setPendingPrefs(prefs: ComposerPrefs) {
    set({ pendingPrefs: { ...get().pendingPrefs, ...prefs } });
  },

  setPendingWorkspace(options: CreateSessionOptions) {
    set({ pendingWorkspace: { ...get().pendingWorkspace, ...options } });
  },

  setProjectFilter(filter: string | "all") {
    set({ projectFilter: filter });
  },

  async refreshGitStatus(sessionId: string) {
    try {
      const status = await window.cw.getGitStatus(sessionId);
      set({ gitStatusBySession: { ...get().gitStatusBySession, [sessionId]: status } });
      if (status.pullRequest?.state === "MERGED") {
        const current = Object.values(get().sessionsByProject)
          .flat()
          .find((s) => s.id === sessionId);
        if (current && current.status !== "resolved" && current.status !== "archived" && sessionId !== get().activeSessionId) {
          void get().setSessionStatus(sessionId, "resolved", { promptWorktree: false }).catch((err) =>
            console.warn(`setSessionStatus failed for ${sessionId} -> resolved: ${(err as Error).message}`)
          );
        }
      }
    } catch {
      // Git errors are rendered by the session-level GitBar when selected.
    }
  },

  preview: null,

  openPreview(sessionId: string, path: string, basePath: string) {
    set({ preview: { sessionId, path, basePath } });
  },

  closePreview() {
    set({ preview: null });
  },

  async loadProjects() {
    const [projects, settings] = await Promise.all([window.cw.listProjects(), window.cw.getSettings()]);
    set({
      projects,
      sourceControlRefreshIntervalSeconds: settings.sourceControlRefreshIntervalSeconds,
      holdingHours: settings.holdingHours,
      defaultUseWorktree: settings.defaultUseWorktree,
      pendingWorkspace: { ...get().pendingWorkspace, ...defaultWorkspace(settings.defaultUseWorktree) }
    });
    if (projects.length === 0 || get().activeProjectId) return;
    const lists = await Promise.all(
      projects.map((p) =>
        window.cw.listSessions(p.id).catch((err: Error) => {
          useNotifs.getState().push({
            kind: "error",
            title: "Could not load sessions",
            message: `${p.name}: ${err.message}`
          });
          return [];
        })
      )
    );
    const sessionsByProject: Record<string, Session[]> = {};
    projects.forEach((p, i) => {
      sessionsByProject[p.id] = lists[i];
    });
    const all = Object.values(sessionsByProject).flat();
    const picked = all
      .filter((s) => s.status !== "archived")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!picked) {
      set({
        sessionsByProject,
        activeProjectId: projects[0].id,
        activeSessionId: null,
        pendingDriver: get().lastDriver
      });
    } else {
      const ownerId =
        picked.projectId ??
        projects.find((p) => (sessionsByProject[p.id] ?? []).some((s) => s.id === picked.id))?.id ??
        projects[0].id;
      set({
        sessionsByProject,
        activeProjectId: ownerId,
        activeSessionId: picked.id,
        pendingDriver: null
      });
      if (picked.status === "resolved") {
        void get().setSessionStatus(picked.id, "idle").catch((err) =>
          console.warn(`setSessionStatus failed for ${picked.id} -> idle: ${(err as Error).message}`)
        );
      }
      void get().ensureHistory(picked.id);
      void get().ensureComposer(picked.id);
      const ordered = [picked.id, ...all.filter((s) => s.id !== picked.id).map((s) => s.id)];
      void refreshGitStatusInBatches(ordered, (id) => get().refreshGitStatus(id));
    }
    void get().loadDiscovered();
  },

  async addProject(rootPath: string) {
    const project = await window.cw.addProject(rootPath);
    set({ projects: [...get().projects, project] });
    await get().selectProject(project.id);
  },

  async selectProject(projectId: string) {
    const sessions = await window.cw.listSessions(projectId);
    const picked = sessions.find((s) => s.status !== "archived");
    if (picked) {
      set({
        activeProjectId: projectId,
        projectFilter: projectId,
        sessionsByProject: { ...get().sessionsByProject, [projectId]: sessions },
        activeSessionId: picked.id,
        pendingDriver: null
      });
      if (picked.status === "resolved") {
        void get().setSessionStatus(picked.id, "idle").catch((err) =>
          console.warn(`setSessionStatus failed for ${picked.id} -> idle: ${(err as Error).message}`)
        );
      }
      void get().ensureHistory(picked.id);
      void get().ensureComposer(picked.id);
      const ordered = [picked.id, ...sessions.filter((s) => s.id !== picked.id).map((s) => s.id)];
      void refreshGitStatusInBatches(ordered, (id) => get().refreshGitStatus(id));
    } else {
      set({
        activeProjectId: projectId,
        projectFilter: projectId,
        sessionsByProject: { ...get().sessionsByProject, [projectId]: sessions },
        activeSessionId: null,
        pendingDriver: get().lastDriver,
        pendingWorkspace: defaultWorkspace(get().defaultUseWorktree)
      });
    }
    void get().loadDiscovered();
  },

  async loadDiscovered() {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    try {
      const discovered = await window.cw.listDiscovered(projectId);
      if (get().activeProjectId === projectId) {
        set({ discoveredByProject: { ...get().discoveredByProject, [projectId]: discovered } });
      }
    } catch {
    }
  },

  async importDiscovered(session: Session) {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    const imported = await window.cw.importSession(projectId, session.driver, session.resumeCursor, session.title);
    set({
      sessionsByProject: {
        ...get().sessionsByProject,
        [projectId]: [imported, ...(get().sessionsByProject[projectId] ?? [])]
      },
      discoveredByProject: {
        ...get().discoveredByProject,
        [projectId]: (get().discoveredByProject[projectId] ?? []).filter((d) => d.id !== session.id)
      },
      activeSessionId: imported.id,
      pendingDriver: null
    });
    void get().ensureHistory(imported.id);
  },

  async renameSession(sessionId: string, title: string) {
    const name = title.trim();
    if (!name) return;
    await window.cw.renameSession(sessionId, name);
    const byProject = get().sessionsByProject;
    const next: Record<string, Session[]> = {};
    for (const [pid, list] of Object.entries(byProject)) {
      next[pid] = list.map((s) => (s.id === sessionId ? { ...s, title: name } : s));
    }
    set({ sessionsByProject: next });
  },

  async regenerateSessionTitle(sessionId: string) {
    const title = await window.cw.regenerateSessionTitle(sessionId);
    get().applySessionTitle(sessionId, title);
  },

  async setSessionStatus(sessionId: string, status: SessionStatus, opts: { promptWorktree?: boolean } = {}) {
    if (status === "resolved" || status === "archived") {
      const result = await window.cw.resolveSession(sessionId, status);
      set({
        sessionsByProject: patchSession(get().sessionsByProject, sessionId, {
          status: result.status,
          updatedAt: Date.now()
        })
      });
      if (result.worktreeOrphaned && opts.promptWorktree !== false) {
        set({
          worktreeConfirmQueue: [
            ...get().worktreeConfirmQueue,
            {
              sessionId,
              status,
              ...(result.unmergedCommitCount !== undefined ? { unmergedCommitCount: result.unmergedCommitCount } : {})
            }
          ]
        });
      }
      return;
    }
    const updated = await window.cw.setSessionStatus(sessionId, status);
    set({
      sessionsByProject: patchSession(get().sessionsByProject, sessionId, {
        status: updated.status,
        updatedAt: updated.updatedAt
      })
    });
  },

  async expireHoldingSessions() {
    const sessions = Object.values(get().sessionsByProject).flat();
    const ids = expiredHoldingIds(sessions, get().holdingHours, Date.now());
    if (ids.length === 0) return;
    try {
      const expired = await window.cw.expireHolding(ids);
      let sessionsByProject = get().sessionsByProject;
      for (const session of expired) {
        sessionsByProject = patchSession(sessionsByProject, session.id, {
          status: session.status,
          updatedAt: session.updatedAt
        });
      }
      set({ sessionsByProject });
    } catch (err) {
      console.warn(`expireHolding failed: ${(err as Error).message}`);
    }
  },

  async confirmWorktreeRemoval() {
    const [target] = get().worktreeConfirmQueue;
    if (!target) return;
    set({ worktreeConfirmQueue: get().worktreeConfirmQueue.slice(1) });
    const appendNotice = (text: string, isError = false) => {
      const notice: ChatMessage = {
        id: `worktree-notice-${target.sessionId}-${Date.now()}`,
        role: "system",
        text,
        turnId: "worktree-cleanup",
        isError
      };
      set({
        messagesBySession: {
          ...get().messagesBySession,
          [target.sessionId]: [...(get().messagesBySession[target.sessionId] ?? []), notice]
        }
      });
    };
    try {
      const result = await window.cw.resolveSession(target.sessionId, target.status, true, true);
      set({
        sessionsByProject: patchSession(get().sessionsByProject, target.sessionId, {
          status: result.status,
          ...(result.worktreeRemoved ? { worktreePath: undefined } : {}),
          ...(result.branchDeleted ? { branch: undefined } : {})
        })
      });
      if (result.dirtyBlocked) {
        appendNotice("Worktree kept: it has uncommitted changes. Commit or clean them, then remove the worktree manually.", true);
      } else if (result.error) {
        useNotifs.getState().push({ kind: "error", title: "Could not remove worktree", message: result.error });
      } else if (!result.worktreeRemoved) {
        appendNotice("Worktree was already gone; nothing to remove.");
      } else if (result.unmergedCommits) {
        appendNotice("Worktree removed; its branch was force-deleted and unmerged commits on it were discarded.");
      } else if (!result.branchDeleted) {
        appendNotice("Worktree removed; its branch was kept.");
      }
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title: "Could not remove worktree", message: (err as Error).message });
    }
  },

  dismissWorktreeRemoval() {
    set({ worktreeConfirmQueue: get().worktreeConfirmQueue.slice(1) });
  },

  selectSession(sessionId: string) {
    const byProject = get().sessionsByProject;
    const current = Object.values(byProject)
      .flat()
      .find((s) => s.id === sessionId);
    if (current?.status === "done") {
      void get().setSessionStatus(sessionId, "holding").catch((err) =>
        console.warn(`setSessionStatus failed for ${sessionId} -> holding: ${(err as Error).message}`)
      );
    } else if (current?.status === "resolved") {
      void get().setSessionStatus(sessionId, "idle").catch((err) =>
        console.warn(`setSessionStatus failed for ${sessionId} -> idle: ${(err as Error).message}`)
      );
    }
    const ownerId = Object.entries(byProject).find(([, list]) =>
      list.some((s) => s.id === sessionId)
    )?.[0];
    const projectChanged = ownerId !== undefined && ownerId !== get().activeProjectId;
    set({
      activeSessionId: sessionId,
      pendingDriver: null,
      ...(ownerId && ownerId !== get().activeProjectId ? { activeProjectId: ownerId } : {})
    });
    if (projectChanged) void get().loadDiscovered();
    void get().ensureHistory(sessionId);
    void get().ensureComposer(sessionId);
    void get().refreshGitStatus(sessionId);
  },

  startNewSession(driver?: DriverName) {
    if (!get().activeProjectId) return;
    set({ pendingDriver: driver ?? get().lastDriver, activeSessionId: null, pendingWorkspace: defaultWorkspace(get().defaultUseWorktree) });
  },

  setPendingDriver(driver: DriverName) {
    if (!get().activeProjectId) return;
    set({ pendingDriver: driver });
  },

  async sendPendingPrompt(prompt: string, attachments: string[] = []) {
    const projectId = get().activeProjectId;
    const driver = get().pendingDriver ?? get().lastDriver;
    const prefs = get().pendingPrefs;
    const workspace = get().pendingWorkspace;
    if (!projectId || (!prompt.trim() && attachments.length === 0)) return;
    try {
      await get().createSession(driver, prefs, workspace);
    } catch (err) {
      useNotifs.getState().push({
        kind: "error",
        title: "Could not start session",
        message: (err as Error).message
      });
      return;
    }
    await get().sendPrompt(prompt, attachments);
  },

  async ensureHistory(sessionId: string, opts?: { force?: boolean; isRetry?: boolean }) {
    if (!opts?.force) {
      if ((get().messagesBySession[sessionId] ?? []).length > 0) return;
      if (get().loadingHistory[sessionId]) return;
    }
    set({
      loadingHistory: { ...get().loadingHistory, [sessionId]: true },
      historyErrorBySession: Object.fromEntries(
        Object.entries(get().historyErrorBySession).filter(([id]) => id !== sessionId)
      )
    });
    try {
      const history = await window.cw.getHistory(sessionId);
      if ((get().messagesBySession[sessionId] ?? []).length === 0 && history.length > 0) {
        set({
          messagesBySession: { ...get().messagesBySession, [sessionId]: mergeToolPairs(history) }
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      set({ historyErrorBySession: { ...get().historyErrorBySession, [sessionId]: message } });
      if (!opts?.isRetry) {
        window.setTimeout(() => {
          if (get().historyErrorBySession[sessionId]) {
            void get().ensureHistory(sessionId, { force: true, isRetry: true });
          }
        }, 2000);
      } else {
        useNotifs.getState().push({
          kind: "error",
          title: "Could not load history",
          message,
          actions: [
            {
              label: "Retry",
              primary: true,
              onClick: () => void get().ensureHistory(sessionId, { force: true, isRetry: true })
            }
          ]
        });
      }
    } finally {
      const loading = { ...get().loadingHistory };
      delete loading[sessionId];
      set({ loadingHistory: loading });
    }
  },

  async ensureComposer(sessionId: string) {
    if (get().composerBySession[sessionId]) return;
    const mirror = readComposerMirror(sessionId);
    if (mirror) {
      set({ composerBySession: { ...get().composerBySession, [sessionId]: { ...DEFAULT_COMPOSER, ...mirror } } });
    } else {
      set({ composerBySession: { ...get().composerBySession, [sessionId]: { ...DEFAULT_COMPOSER } } });
    }
    try {
      const prefs = await window.cw.getComposer(sessionId);
      set({
        composerBySession: { ...get().composerBySession, [sessionId]: { ...DEFAULT_COMPOSER, ...prefs } }
      });
    } catch {
    }
  },

  async setComposerPrefs(sessionId: string, prefs: ComposerPrefs) {
    const merged = { ...(get().composerBySession[sessionId] ?? DEFAULT_COMPOSER), ...prefs };
    set({ composerBySession: { ...get().composerBySession, [sessionId]: merged } });
    try {
      window.localStorage.setItem(`cw:composer:${sessionId}`, JSON.stringify(merged));
    } catch {
    }
    try {
      const saved = await window.cw.setComposer(sessionId, merged);
      set({ composerBySession: { ...get().composerBySession, [sessionId]: { ...DEFAULT_COMPOSER, ...saved } } });
    } catch {
    }
  },

  async saveSettings(patch: SettingsPatch) {
    const saved = await window.cw.setSettings(patch);
    set({
      settingsVersion: get().settingsVersion + 1,
      sourceControlRefreshIntervalSeconds: saved.sourceControlRefreshIntervalSeconds,
      holdingHours: saved.holdingHours,
      defaultUseWorktree: saved.defaultUseWorktree
    });
    return saved;
  },

  async setProjectGitHubAccount(projectId: string, account: { host: string; login: string } | null) {
    const updated = await window.cw.setProjectGitHubAccount(projectId, account);
    set({ projects: get().projects.map((project) => project.id === projectId ? updated : project) });
    const ids = (get().sessionsByProject[projectId] ?? []).map((session) => session.id);
    void refreshGitStatusInBatches(ids, (id) => get().refreshGitStatus(id));
  },

  async createSession(driver: DriverName, prefs?: ComposerPrefs, workspace?: CreateSessionOptions) {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    const session = await window.cw.createSession(projectId, driver, workspace);
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
    set({
      sessionsByProject: {
        ...get().sessionsByProject,
        [projectId]: [session, ...(get().sessionsByProject[projectId] ?? [])]
      },
      activeSessionId: session.id,
      pendingDriver: null,
      lastDriver: driver
    });
    await get().ensureComposer(session.id);
    if (prefs) await get().setComposerPrefs(session.id, { ...prefs });
    void get().refreshGitStatus(session.id);
  },

  async sendPrompt(prompt: string, attachments?: string[]) {
    const sessionId = get().activeSessionId;
    if (!sessionId || !prompt.trim()) return;
    const prefs = get().composerBySession[sessionId] ?? DEFAULT_COMPOSER;
    const turnId = await window.cw.startTurn(sessionId, prompt, { prefs, attachments });
    const startedAt = { ...get().turnStartedAt, [sessionId]: Date.now() };
    const lastStats = { ...get().lastTurnStats };
    delete lastStats[sessionId];
    set({
      busyTurns: { ...get().busyTurns, [sessionId]: turnId },
      turnStartedAt: startedAt,
      lastTurnStats: lastStats,
      sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, "working"),
      messagesBySession: {
        ...get().messagesBySession,
        [sessionId]: [
          ...(get().messagesBySession[sessionId] ?? []),
          { id: `${turnId}-u`, role: "user", text: prompt, turnId }
        ]
      }
    });
  },

  async interrupt() {
    const sessionId = get().activeSessionId;
    const turnId = sessionId ? get().busyTurns[sessionId] : undefined;
    if (!turnId) return;
    await window.cw.interrupt(turnId);
    const busy = { ...get().busyTurns };
    if (sessionId) delete busy[sessionId];
    set({
      busyTurns: busy,
      ...(sessionId ? { sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, "holding") } : {})
    });
  },

  async respondApproval(requestId: string, decision: ApprovalDecision) {
    await window.cw.respondApproval(requestId, decision);
    const approvals = get().pendingApprovals;
    let changed = false;
    const next: Record<string, ApprovalRequest[]> = {};
    for (const [sessionId, list] of Object.entries(approvals)) {
      const filtered = list.filter((p) => p.requestId !== requestId);
      if (filtered.length !== list.length) changed = true;
      next[sessionId] = filtered;
    }
    if (changed) set({ pendingApprovals: next });
  },

  async respondQuestion(sessionId: string, requestId: string, answers: Record<string, string>) {
    await window.cw.respondQuestion(requestId, answers);
    const pending = get().pendingQuestions[sessionId] ?? [];
    set({
      pendingQuestions: {
        ...get().pendingQuestions,
        [sessionId]: pending.filter((q) => q.requestId !== requestId)
      }
    });
  },

  applyEvent(sessionId: string, event: TurnEvent) {
    const messages = get().messagesBySession[sessionId] ?? [];
    if (event.type === "assistant.delta") {
      set({
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]: appendAssistantText(messages, event.turnId, event.text)
        }
      });
    } else if (event.type === "approval.request") {
      const pending = get().pendingApprovals[sessionId] ?? [];
      if (pending.some((p) => p.requestId === event.request.requestId)) return;
      set({
        pendingApprovals: {
          ...get().pendingApprovals,
          [sessionId]: [...pending, event.request]
        },
        sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, "input-required")
      });
    } else if (event.type === "approval.resolved") {
      const pending = (get().pendingApprovals[sessionId] ?? []).filter(
        (p) => p.requestId !== event.requestId
      );
      set({
        pendingApprovals: {
          ...get().pendingApprovals,
          [sessionId]: pending
        },
        ...(get().busyTurns[sessionId]
          ? { sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, "working") }
          : {})
      });
    } else if (event.type === "question.request") {
      const pending = get().pendingQuestions[sessionId] ?? [];
      if (pending.some((q) => q.requestId === event.request.requestId)) return;
      set({
        pendingQuestions: {
          ...get().pendingQuestions,
          [sessionId]: [...pending, event.request]
        },
        sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, "input-required")
      });
    } else if (event.type === "question.resolved") {
      const pending = (get().pendingQuestions[sessionId] ?? []).filter(
        (q) => q.requestId !== event.requestId
      );
      const notes: ChatMessage[] = event.answers
        ? [
            {
              id: `${event.requestId}-ans`,
              role: "tool",
              text: Object.entries(event.answers)
                .map(([q, a]) => `${q} → ${a}`)
                .join("\n"),
              turnId: event.turnId,
              toolCompletedAt: Date.now()
            }
          ]
        : [];
      set({
        pendingQuestions: {
          ...get().pendingQuestions,
          [sessionId]: pending
        },
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]: [...messages, ...notes]
        },
        ...(get().busyTurns[sessionId]
          ? { sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, "working") }
          : {})
      });
    } else if (event.type === "tool.call") {
      set({
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]: [
            ...messages,
            {
              id: event.toolCallId,
              role: "tool",
              text: `${event.name} ${JSON.stringify(event.input)?.slice(0, 300) ?? ""}`,
              turnId: event.turnId,
              toolName: event.name,
              toolInput: event.input,
              toolStartedAt: Date.now(),
              ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {})
            }
          ]
        }
      });
    } else if (event.type === "tool.result") {
      const idx = messages.findIndex((m) => m.id === event.toolCallId);
      if (idx >= 0 && messages[idx].role === "tool") {
        const updated = [...messages];
        const call = updated[idx];
        updated[idx] = {
          ...call,
          toolOutput: event.output.slice(0, 8000),
          toolDone: true,
          toolCompletedAt: Date.now(),
          isError: call.isError === true || event.isError
        };
        set({
          messagesBySession: { ...get().messagesBySession, [sessionId]: updated }
        });
      } else {
        set({
          messagesBySession: {
            ...get().messagesBySession,
            [sessionId]: [
              ...messages,
              {
                id: `${event.toolCallId}-r`,
                role: "tool",
                text: event.output.slice(0, 1000),
                turnId: event.turnId,
                isError: event.isError,
                toolCompletedAt: Date.now()
              }
            ]
          }
        });
      }
    } else if (event.type === "turn.done") {
      const backgroundTasks = event.backgroundTasks ?? 0;
      const busy = { ...get().busyTurns };
      if (backgroundTasks === 0) delete busy[sessionId];
      const startedAt = get().turnStartedAt[sessionId];
      const stats = { ...get().lastTurnStats };
      if (startedAt !== undefined) stats[sessionId] = { ms: Date.now() - startedAt };
      const approvals = { ...get().pendingApprovals };
      delete approvals[sessionId];
      const questions = { ...get().pendingQuestions };
      delete questions[sessionId];
      let turnMessages = finalizeTurnTools(messages, event.turnId, backgroundTasks);
      if (event.isError && !turnMessages.some((m) => m.id === `${event.turnId}-e`)) {
        turnMessages = [
          ...turnMessages,
          {
            id: `${event.turnId}-e`,
            role: "system",
            text: `Error: ${event.resultText || "Claude reported an error with no output."}`,
            turnId: event.turnId,
            isError: true
          }
        ];
      }
      set({
        busyTurns: busy,
        lastTurnStats: stats,
        pendingApprovals: approvals,
        pendingQuestions: questions,
        sessionsByProject: withSessionStatus(
          get().sessionsByProject,
          sessionId,
          backgroundTasks > 0 ? "working" : "done"
        ),
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]: turnMessages
        },
        usageBySession: {
          ...get().usageBySession,
          [sessionId]: {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            costUsd: event.costUsd,
            numTurns: event.numTurns
          }
        }
      });
      void get().refreshGitStatus(sessionId);
    } else if (event.type === "session.branch.updated") {
      const byProject = get().sessionsByProject;
      const next: Record<string, Session[]> = {};
      for (const [pid, list] of Object.entries(byProject)) {
        next[pid] = list.map((s) => (s.id === sessionId ? { ...s, branch: event.branch } : s));
      }
      set({ sessionsByProject: next });
      void get().refreshGitStatus(sessionId);
    } else if (event.type === "turn.error") {
      const busy = { ...get().busyTurns };
      delete busy[sessionId];
      const approvals = { ...get().pendingApprovals };
      delete approvals[sessionId];
      const questions = { ...get().pendingQuestions };
      delete questions[sessionId];
      set({
        busyTurns: busy,
        pendingApprovals: approvals,
        pendingQuestions: questions,
        sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, "holding"),
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]: [
            ...finalizeTurnTools(messages, event.turnId),
            { id: `${event.turnId}-e`, role: "system", text: `Error: ${event.message}`, turnId: event.turnId, isError: true }
          ]
        }
      });
    }
  },

  applySessionTitle(sessionId: string, title: string) {
    const byProject = get().sessionsByProject;
    let changed = false;
    const next: Record<string, Session[]> = {};
    for (const [pid, list] of Object.entries(byProject)) {
      next[pid] = list.map((s) => {
        if (s.id !== sessionId || s.title === title) return s;
        changed = true;
        return { ...s, title };
      });
    }
    if (!changed) return;
    set({ sessionsByProject: next });
  }
}));
