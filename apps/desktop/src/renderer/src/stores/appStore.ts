import { create } from "zustand";
import type {
  ActiveTurn,
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
  SubagentToolsResult,
  TodoItem,
  TurnEvent
} from "../cw.js";
import { appendAssistantText, appendReasoningText, closeReasoning, upsertToolCall } from "../components/chatMessages.js";
import { formatDuration, mergeToolPairs } from "../components/toolSummaries.js";
import { expiredHoldingIds } from "../components/workingSet.js";
import { useNotifs } from "../components/Notifications.js";

const GIT_REFRESH_BATCH = 6;
const PENDING_PREFIX = "pending:";
let pendingSeq = 0;
let pendingPromptInFlight = false;

function nextPendingTurnId(): string {
  pendingSeq += 1;
  return `${PENDING_PREFIX}${pendingSeq}`;
}

function isPendingTurn(value: string | undefined): boolean {
  return value !== undefined && value.startsWith(PENDING_PREFIX);
}

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
  reasoningStartedAt?: number;
  retryable?: boolean;
  severity?: "warning";
}

export const DEFAULT_COMPOSER: Required<Pick<ComposerPrefs, "effort" | "permissionMode">> & ComposerPrefs = {
  effort: "medium",
  permissionMode: "auto"
};

function defaultWorkspace(defaultUseWorktree: boolean): CreateSessionOptions {
  return { mode: defaultUseWorktree ? "new" : "current" };
}

function reasoningExpandedFrom(settings: AppSettings): Record<DriverName, boolean> {
  return {
    claude: settings.claudeReasoningExpanded,
    opencode: settings.opencodeReasoningExpanded,
    codex: settings.codexReasoningExpanded
  };
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
  todosBySession: Record<string, TodoItem[]>;
  usageBySession: Record<string, Usage>;
  busyTurns: Record<string, string>;
  loadingHistory: Record<string, boolean>;
  historyErrorBySession: Record<string, string>;
  turnStartedAt: Record<string, number>;
  turnDurations: Record<string, Record<string, number>>;
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
  reasoningExpandedByDriver: Record<DriverName, boolean>;
  preview: { sessionId: string; path: string; basePath: string } | null;
  openPreview(sessionId: string, path: string, basePath: string): void;
  closePreview(): void;
  loadProjects(): Promise<void>;
  addProject(rootPath: string): Promise<void>;
  selectProject(projectId: string): Promise<void>;
  selectSession(sessionId: string): void;
  hydrateActiveTurns(): Promise<void>;
  startNewSession(driver?: DriverName): void;
  setPendingDriver(driver: DriverName): void;
  sendPendingPrompt(prompt: string, attachments?: string[]): Promise<void>;
  ensureHistory(sessionId: string, opts?: { force?: boolean; isRetry?: boolean }): Promise<void>;
  subagentToolsByKey: Record<string, SubagentToolsResult>;
  subagentToolsLoading: Record<string, boolean>;
  loadSubagentTools(sessionId: string, agentId: string): Promise<void>;
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
  retryConnection(sessionId: string): Promise<void>;
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

function withoutRetryNotice(messages: ChatMessage[], turnId: string): ChatMessage[] {
  const id = `${turnId}-retry`;
  return messages.some((m) => m.id === id) ? messages.filter((m) => m.id !== id) : messages;
}

function withSessionStatus(
  byProject: Record<string, Session[]>,
  sessionId: string,
  status: SessionStatus
): Record<string, Session[]> {
  return patchSession(byProject, sessionId, { status, updatedAt: Date.now() });
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

interface TurnBookkeeping {
  busyTurns: Record<string, string>;
  turnStartedAt: Record<string, number>;
  turnDurations: Record<string, Record<string, number>>;
}

function closeTurn(book: TurnBookkeeping, sessionId: string, turnId: string | undefined): TurnBookkeeping {
  const busyTurns = { ...book.busyTurns };
  const turnStartedAt = { ...book.turnStartedAt };
  const turnDurations = { ...book.turnDurations };
  delete busyTurns[sessionId];
  const startedAt = turnStartedAt[sessionId];
  if (turnId !== undefined && startedAt !== undefined) {
    turnDurations[sessionId] = {
      ...(turnDurations[sessionId] ?? {}),
      [turnId]: Math.max(0, Date.now() - startedAt)
    };
  }
  delete turnStartedAt[sessionId];
  return { busyTurns, turnStartedAt, turnDurations };
}

function knownTurnId(value: string | undefined): string | undefined {
  return value !== undefined && !isPendingTurn(value) ? value : undefined;
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  sessionsByProject: {},
  discoveredByProject: {},
  activeProjectId: null,
  projectFilter: "all",
  activeSessionId: null,
  messagesBySession: {},
  todosBySession: {},
  usageBySession: {},
  busyTurns: {},
  loadingHistory: {},
  historyErrorBySession: {},
  subagentToolsByKey: {},
  subagentToolsLoading: {},
  turnStartedAt: {},
  turnDurations: {},
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
  reasoningExpandedByDriver: { claude: false, opencode: false, codex: false },

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
      reasoningExpandedByDriver: reasoningExpandedFrom(settings),
      pendingWorkspace: { ...get().pendingWorkspace, ...defaultWorkspace(settings.defaultUseWorktree) }
    });
    void get().hydrateActiveTurns();
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
      } else if (picked.status === "done") {
        void get().setSessionStatus(picked.id, "holding").catch((err) =>
          console.warn(`setSessionStatus failed for ${picked.id} -> holding: ${(err as Error).message}`)
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
      } else if (picked.status === "done") {
        void get().setSessionStatus(picked.id, "holding").catch((err) =>
          console.warn(`setSessionStatus failed for ${picked.id} -> holding: ${(err as Error).message}`)
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
    void get().hydrateActiveTurns();
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
      if (expired.length === 0) return;
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

  async hydrateActiveTurns() {
    let active: ActiveTurn[] = [];
    try {
      active = await window.cw.activeTurns();
    } catch (err) {
      console.warn(`activeTurns failed: ${(err as Error).message}`);
      return;
    }
    const localBusy = get().busyTurns;
    const localStarted = get().turnStartedAt;
    const durations = get().turnDurations;
    const busy: Record<string, string> = {};
    const startedAt: Record<string, number> = {};
    for (const turn of active) {
      if (durations[turn.sessionId]?.[turn.turnId] !== undefined) continue;
      if (isPendingTurn(localBusy[turn.sessionId])) continue;
      busy[turn.sessionId] = turn.turnId;
      startedAt[turn.sessionId] = turn.startedAt;
    }
    for (const [sessionId, value] of Object.entries(localBusy)) {
      if (!isPendingTurn(value)) continue;
      busy[sessionId] = value;
      startedAt[sessionId] = localStarted[sessionId] ?? Date.now();
    }
    set({ busyTurns: busy, turnStartedAt: startedAt });
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
    void get().hydrateActiveTurns();
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
    if (pendingPromptInFlight) return;
    pendingPromptInFlight = true;
    try {
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
    } finally {
      pendingPromptInFlight = false;
    }
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
        const merged = mergeToolPairs(history);
        set({
          messagesBySession: { ...get().messagesBySession, [sessionId]: merged }
        });
        if (get().todosBySession[sessionId] === undefined) {
          const seeded = [...merged].reverse().find((m) => m.todos !== undefined)?.todos;
          if (seeded !== undefined) {
            set({ todosBySession: { ...get().todosBySession, [sessionId]: seeded } });
          }
        }
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
      defaultUseWorktree: saved.defaultUseWorktree,
      reasoningExpandedByDriver: reasoningExpandedFrom(saved)
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
    const previous = Object.values(get().sessionsByProject)
      .flat()
      .find((s) => s.id === sessionId);
    const previousTodos = get().todosBySession[sessionId];
    const pending = nextPendingTurnId();
    set({
      busyTurns: { ...get().busyTurns, [sessionId]: pending },
      turnStartedAt: { ...get().turnStartedAt, [sessionId]: Date.now() },
      todosBySession: { ...get().todosBySession, [sessionId]: [] },
      sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, "working")
    });
    let turnId: string;
    try {
      turnId = await window.cw.startTurn(sessionId, prompt, { prefs, attachments });
    } catch (err) {
      if (get().busyTurns[sessionId] === pending) {
        const book = closeTurn(
          { busyTurns: get().busyTurns, turnStartedAt: get().turnStartedAt, turnDurations: get().turnDurations },
          sessionId,
          undefined
        );
        set({
          busyTurns: book.busyTurns,
          turnStartedAt: book.turnStartedAt,
          turnDurations: book.turnDurations,
          ...(previousTodos && previousTodos.length > 0 && (get().todosBySession[sessionId] ?? []).length === 0
            ? { todosBySession: { ...get().todosBySession, [sessionId]: previousTodos } }
            : {}),
          ...(previous
            ? { sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, previous.status) }
            : {})
        });
      }
      throw err;
    }
    const superseded = get().busyTurns[sessionId] !== pending;
    set({
      ...(superseded ? {} : { busyTurns: { ...get().busyTurns, [sessionId]: turnId } }),
      messagesBySession: {
        ...get().messagesBySession,
        [sessionId]: [
          ...(get().messagesBySession[sessionId] ?? []),
          { id: `${turnId}-u`, role: "user", text: prompt, turnId }
        ]
      }
    });
    if (superseded) void window.cw.interrupt(turnId);
    else void get().hydrateActiveTurns();
  },

  async interrupt() {
    const sessionId = get().activeSessionId;
    const turnId = sessionId ? get().busyTurns[sessionId] : undefined;
    if (!turnId) return;
    if (!isPendingTurn(turnId)) await window.cw.interrupt(turnId);
    const book = closeTurn(
      { busyTurns: get().busyTurns, turnStartedAt: get().turnStartedAt, turnDurations: get().turnDurations },
      sessionId ?? "",
      knownTurnId(turnId)
    );
    set({
      busyTurns: book.busyTurns,
      turnStartedAt: book.turnStartedAt,
      turnDurations: book.turnDurations,
      ...(sessionId
        ? { sessionsByProject: patchSession(get().sessionsByProject, sessionId, { status: "holding", updatedAt: Date.now() }) }
        : {})
    });
  },

  async retryConnection(sessionId: string) {
    try {
      const result = await window.cw.retryConnection(sessionId);
      const running = result.status === "running" && result.turnId ? result.turnId : undefined;
      const current = { busyTurns: get().busyTurns, turnStartedAt: get().turnStartedAt, turnDurations: get().turnDurations };
      const book: TurnBookkeeping = running
        ? {
            busyTurns: { ...current.busyTurns, [sessionId]: running },
            turnStartedAt: { ...current.turnStartedAt, [sessionId]: Date.now() },
            turnDurations: current.turnDurations
          }
        : closeTurn(current, sessionId, knownTurnId(current.busyTurns[sessionId]));
      set({
        busyTurns: book.busyTurns,
        turnStartedAt: book.turnStartedAt,
        turnDurations: book.turnDurations,
        sessionsByProject: withSessionStatus(
          get().sessionsByProject,
          sessionId,
          running ? "working" : "idle"
        ),
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]: mergeToolPairs(result.history)
        }
      });
      void get().hydrateActiveTurns();
    } catch (err) {
      useNotifs.getState().push({
        kind: "error",
        title: "Could not reconnect",
        message: (err as Error).message
      });
    }
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
    let messages = get().messagesBySession[sessionId] ?? [];
    if (event.type !== "turn.retry" && event.type !== "turn.done" && event.type !== "turn.error" && "turnId" in event) {
      const stripped = withoutRetryNotice(messages, event.turnId);
      if (stripped !== messages) {
        messages = stripped;
        set({ messagesBySession: { ...get().messagesBySession, [sessionId]: stripped } });
      }
    }
    if (event.type === "reasoning.delta") {
      set({
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]: appendReasoningText(messages, event.turnId, event.text, Date.now())
        }
      });
      return;
    }
    messages = closeReasoning(messages, Date.now());
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
        ...(pending.length > 0
          ? { sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, "input-required") }
          : get().busyTurns[sessionId]
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
        ...(pending.length > 0
          ? { sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, "input-required") }
          : get().busyTurns[sessionId]
            ? { sessionsByProject: withSessionStatus(get().sessionsByProject, sessionId, "working") }
            : {})
      });
    } else if (event.type === "tool.call") {
      set({
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]: upsertToolCall(messages, event, Date.now())
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
          isError: call.isError === true || event.isError,
          ...(event.usage ? { toolUsage: event.usage } : {}),
          ...(event.agentId ? { subagentAgentId: event.agentId } : {}),
          ...(event.model ? { subagentModel: event.model } : {})
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
                ...(event.usage ? { toolUsage: event.usage } : {}),
                ...(event.agentId ? { subagentAgentId: event.agentId } : {}),
                ...(event.model ? { subagentModel: event.model } : {}),
                toolCompletedAt: Date.now()
              }
            ]
          }
        });
      }
    } else if (event.type === "todo.updated") {
      set({
        todosBySession: { ...get().todosBySession, [sessionId]: event.todos }
      });
    } else if (event.type === "turn.retry") {
      const id = `${event.turnId}-retry`;
      const now = Date.now();
      const attempt = event.attempt > 0 ? ` (attempt ${event.attempt})` : "";
      const wait = event.retryAt > now ? ` in ${formatDuration(event.retryAt - now)}` : "";
      const lines = [`Retrying${wait}${attempt}: ${event.message}`];
      if (event.detail) lines.push(event.detail);
      if (event.link) lines.push(event.link);
      const text = lines.join("\n");
      const idx = messages.findIndex((m) => m.id === id);
      const notice: ChatMessage = { id, role: "system", text, turnId: event.turnId, severity: "warning" };
      set({
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]:
            idx >= 0
              ? [...messages.slice(0, idx), { ...messages[idx], text }, ...messages.slice(idx + 1)]
              : [...messages, notice]
        }
      });
    } else if (event.type === "turn.done") {
      const backgroundTasks = event.backgroundTasks ?? 0;
      const current = get().busyTurns[sessionId] === event.turnId && backgroundTasks === 0;
      const book = current
        ? closeTurn(
            { busyTurns: get().busyTurns, turnStartedAt: get().turnStartedAt, turnDurations: get().turnDurations },
            sessionId,
            event.turnId
          )
        : { busyTurns: get().busyTurns, turnStartedAt: get().turnStartedAt, turnDurations: get().turnDurations };
      const approvals = { ...get().pendingApprovals };
      delete approvals[sessionId];
      const questions = { ...get().pendingQuestions };
      delete questions[sessionId];
      let turnMessages = finalizeTurnTools(messages, event.turnId, backgroundTasks).filter(
        (m) => m.id !== `${event.turnId}-retry`
      );
      if (!event.isError) {
        const resultText = event.resultText ?? "";
        if (resultText.trim()) {
          const alreadyShown = turnMessages.some(
            (m) => m.role === "assistant" && m.turnId === event.turnId && m.text.includes(resultText)
          );
          if (!alreadyShown) {
            const last = turnMessages[turnMessages.length - 1];
            if (
              last &&
              last.role === "assistant" &&
              last.turnId === event.turnId &&
              resultText.startsWith(last.text) &&
              last.text.trim()
            ) {
              const suffix = resultText.slice(last.text.length);
              if (suffix.trim()) turnMessages = appendAssistantText(turnMessages, event.turnId, suffix);
            } else {
              turnMessages = appendAssistantText(turnMessages, event.turnId, resultText);
            }
          }
        }
      }
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
        busyTurns: book.busyTurns,
        turnStartedAt: book.turnStartedAt,
        turnDurations: book.turnDurations,
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
      const book =
        get().busyTurns[sessionId] === event.turnId
          ? closeTurn(
              { busyTurns: get().busyTurns, turnStartedAt: get().turnStartedAt, turnDurations: get().turnDurations },
              sessionId,
              event.turnId
            )
          : { busyTurns: get().busyTurns, turnStartedAt: get().turnStartedAt, turnDurations: get().turnDurations };
      const approvals = { ...get().pendingApprovals };
      delete approvals[sessionId];
      const questions = { ...get().pendingQuestions };
      delete questions[sessionId];
      set({
        busyTurns: book.busyTurns,
        turnStartedAt: book.turnStartedAt,
        turnDurations: book.turnDurations,
        pendingApprovals: approvals,
        pendingQuestions: questions,
        sessionsByProject: patchSession(get().sessionsByProject, sessionId, { status: "holding", updatedAt: Date.now() }),
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]: [
            ...finalizeTurnTools(messages, event.turnId).filter((m) => m.id !== `${event.turnId}-retry`),
            {
              id: `${event.turnId}-e`,
              role: "system",
              text: `Error: ${event.message}`,
              turnId: event.turnId,
              isError: true,
              ...(event.retryable ? { retryable: true } : {})
            }
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
