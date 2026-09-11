import { create } from "zustand";
import type {
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  ComposerPrefs,
  DriverName,
  HistoryMessage,
  Project,
  QuestionRequest,
  Session,
  SettingsPatch,
  TurnEvent
} from "../cw.js";
import { mergeToolPairs } from "../components/toolSummaries.js";
import { useNotifs } from "../components/Notifications.js";

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
  activeSessionId: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  usageBySession: Record<string, Usage>;
  busyTurns: Record<string, string>;
  loadingHistory: Record<string, boolean>;
  turnStartedAt: Record<string, number>;
  lastTurnStats: Record<string, { ms: number }>;
  composerBySession: Record<string, ComposerPrefs>;
  pendingDriver: DriverName | null;
  lastDriver: DriverName;
  pendingApprovals: Record<string, ApprovalRequest[]>;
  pendingQuestions: Record<string, QuestionRequest[]>;
  pendingPrefs: ComposerPrefs;
  setPendingPrefs(prefs: ComposerPrefs): void;
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
  ensureHistory(sessionId: string): Promise<void>;
  ensureComposer(sessionId: string): Promise<void>;
  setComposerPrefs(sessionId: string, prefs: ComposerPrefs): Promise<void>;
  settingsVersion: number;
  saveSettings(patch: SettingsPatch): Promise<AppSettings>;
  loadDiscovered(): Promise<void>;
  importDiscovered(session: Session): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  createSession(driver: DriverName, prefs?: ComposerPrefs): Promise<void>;
  sendPrompt(prompt: string, attachments?: string[]): Promise<void>;
  interrupt(): Promise<void>;
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  respondQuestion(sessionId: string, requestId: string, answers: Record<string, string>): Promise<void>;
  applyEvent(sessionId: string, event: TurnEvent): void;
}

function finalizeTurnTools(messages: ChatMessage[], turnId: string): ChatMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "tool" || m.turnId !== turnId) return m;
    if (m.toolInput === undefined || m.toolDone === true || m.toolOutput !== undefined) return m;
    changed = true;
    return { ...m, toolDone: true, toolCompletedAt: Date.now() };
  });
  return changed ? out : messages;
}

function appendAssistantText(messages: ChatMessage[], turnId: string, text: string): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.turnId === turnId) {
    return [...messages.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...messages, { id: `${turnId}-a`, role: "assistant", text, turnId }];
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  sessionsByProject: {},
  discoveredByProject: {},
  activeProjectId: null,
  activeSessionId: null,
  messagesBySession: {},
  usageBySession: {},
  busyTurns: {},
  loadingHistory: {},
  turnStartedAt: {},
  lastTurnStats: {},
  composerBySession: {},
  settingsVersion: 0,
  pendingDriver: null,
  lastDriver: "claude",
  pendingApprovals: {},
  pendingQuestions: {},
  pendingPrefs: { ...DEFAULT_COMPOSER },

  setPendingPrefs(prefs: ComposerPrefs) {
    set({ pendingPrefs: { ...get().pendingPrefs, ...prefs } });
  },

  preview: null,

  openPreview(sessionId: string, path: string, basePath: string) {
    set({ preview: { sessionId, path, basePath } });
  },

  closePreview() {
    set({ preview: null });
  },

  async loadProjects() {
    const projects = await window.cw.listProjects();
    set({ projects });
    if (projects.length > 0 && !get().activeProjectId) {
      await get().selectProject(projects[0].id);
    }
  },

  async addProject(rootPath: string) {
    const project = await window.cw.addProject(rootPath);
    set({ projects: [...get().projects, project] });
    await get().selectProject(project.id);
  },

  async selectProject(projectId: string) {
    const sessions = await window.cw.listSessions(projectId);
    if (sessions.length > 0) {
      set({
        activeProjectId: projectId,
        sessionsByProject: { ...get().sessionsByProject, [projectId]: sessions },
        activeSessionId: sessions[0].id,
        pendingDriver: null
      });
      void get().ensureHistory(sessions[0].id);
      void get().ensureComposer(sessions[0].id);
    } else {
      set({
        activeProjectId: projectId,
        sessionsByProject: { ...get().sessionsByProject, [projectId]: sessions },
        activeSessionId: null,
        pendingDriver: get().lastDriver
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

  selectSession(sessionId: string) {    set({ activeSessionId: sessionId, pendingDriver: null });
    void get().ensureHistory(sessionId);
    void get().ensureComposer(sessionId);
  },

  startNewSession(driver?: DriverName) {
    if (!get().activeProjectId) return;
    set({ pendingDriver: driver ?? get().lastDriver, activeSessionId: null });
  },

  setPendingDriver(driver: DriverName) {
    if (!get().activeProjectId) return;
    set({ pendingDriver: driver });
  },

  async sendPendingPrompt(prompt: string, attachments: string[] = []) {
    const projectId = get().activeProjectId;
    const driver = get().pendingDriver ?? get().lastDriver;
    const prefs = get().pendingPrefs;
    if (!projectId || (!prompt.trim() && attachments.length === 0)) return;
    try {
      await get().createSession(driver, prefs);
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

  async ensureHistory(sessionId: string) {
    if ((get().messagesBySession[sessionId] ?? []).length > 0) return;
    if (get().loadingHistory[sessionId]) return;
    set({ loadingHistory: { ...get().loadingHistory, [sessionId]: true } });
    try {
      const history = await window.cw.getHistory(sessionId);
      if ((get().messagesBySession[sessionId] ?? []).length === 0 && history.length > 0) {
        set({
          messagesBySession: { ...get().messagesBySession, [sessionId]: mergeToolPairs(history) }
        });
      }
    } catch {
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
    set({ settingsVersion: get().settingsVersion + 1 });
    return saved;
  },

  async createSession(driver: DriverName, prefs?: ComposerPrefs) {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    const session = await window.cw.createSession(projectId, driver);
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
    set({ busyTurns: busy });
  },

  async respondApproval(requestId: string, decision: ApprovalDecision) {
    await window.cw.respondApproval(requestId, decision);
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
        }
      });
    } else if (event.type === "approval.resolved") {
      const pending = (get().pendingApprovals[sessionId] ?? []).filter(
        (p) => p.requestId !== event.requestId
      );
      set({
        pendingApprovals: {
          ...get().pendingApprovals,
          [sessionId]: pending
        }
      });
    } else if (event.type === "question.request") {
      const pending = get().pendingQuestions[sessionId] ?? [];
      if (pending.some((q) => q.requestId === event.request.requestId)) return;
      set({
        pendingQuestions: {
          ...get().pendingQuestions,
          [sessionId]: [...pending, event.request]
        }
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
        }
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
      const busy = { ...get().busyTurns };
      delete busy[sessionId];
      const startedAt = get().turnStartedAt[sessionId];
      const stats = { ...get().lastTurnStats };
      if (startedAt !== undefined) stats[sessionId] = { ms: Date.now() - startedAt };
      const approvals = { ...get().pendingApprovals };
      delete approvals[sessionId];
      const questions = { ...get().pendingQuestions };
      delete questions[sessionId];
      set({
        busyTurns: busy,
        lastTurnStats: stats,
        pendingApprovals: approvals,
        pendingQuestions: questions,
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]: finalizeTurnTools(messages, event.turnId)
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
        messagesBySession: {
          ...get().messagesBySession,
          [sessionId]: [
            ...finalizeTurnTools(messages, event.turnId),
            { id: `${event.turnId}-e`, role: "system", text: `Error: ${event.message}`, turnId: event.turnId, isError: true }
          ]
        }
      });
    }
  }
}));
