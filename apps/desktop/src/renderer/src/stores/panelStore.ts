import { create } from "zustand";
import type { DockableTabId, DockLocation, GitDiffMode, MainTabId, PanelId } from "@cw-code/contracts";
import {
  DEFAULT_RIGHT_TOOL,
  PANEL_LAYOUT_KEY,
  PANEL_STATE_KEY,
  clampBottomHeight,
  defaultSessionPanel,
  needsDefaultRightTool,
  parsePanelState,
  sanitizeSessionPanel,
  serializePanelState,
  tabsInPanel,
  type LoadedPanelState,
  type PersistedPanelState,
  type SessionPanelState
} from "./panelLayout.js";

const DEFAULT_SESSION_PANEL = defaultSessionPanel();

let revealNonce = 0;
let diffModeNonce = 0;

function loadState(): LoadedPanelState {
  try {
    return parsePanelState(
      window.localStorage.getItem(PANEL_STATE_KEY),
      window.localStorage.getItem(PANEL_LAYOUT_KEY)
    );
  } catch {
    return parsePanelState(null, null);
  }
}

function persist(state: PersistedPanelState): void {
  try {
    window.localStorage.setItem(PANEL_STATE_KEY, serializePanelState(state));
  } catch {
  }
}

function panelFor(state: PanelStore, sessionId: string | undefined): SessionPanelState {
  if (!sessionId) return DEFAULT_SESSION_PANEL;
  return state.sessions[sessionId] ?? state.legacySession ?? DEFAULT_SESSION_PANEL;
}

function moveState(current: SessionPanelState, tab: DockableTabId, panel: DockLocation): SessionPanelState {
  const dockByTab = { ...current.dockByTab, [tab]: panel };
  let mainOrder = current.mainOrder.filter((id) => id === "chat" || dockByTab[id] === "main");
  if (panel === "main" && !mainOrder.includes(tab)) mainOrder = [...mainOrder, tab];
  let activeMain = current.activeMain;
  if (panel === "main") {
    activeMain = tab;
  } else if (activeMain !== "chat" && dockByTab[activeMain] !== "main") {
    activeMain = "chat";
  }
  let activeRight = current.activeRight;
  if (panel === "right") {
    activeRight = tab;
  } else if (dockByTab[activeRight] !== "right") {
    activeRight = tabsInPanel(dockByTab, "right")[0] ?? activeRight;
  }
  let activeBottom = current.activeBottom;
  if (panel === "bottom") {
    activeBottom = tab;
  } else if (dockByTab[activeBottom] !== "bottom") {
    activeBottom = tabsInPanel(dockByTab, "bottom")[0] ?? activeBottom;
  }
  return sanitizeSessionPanel({ ...current, dockByTab, activeMain, activeRight, activeBottom, mainOrder });
}

export interface PanelActions {
  setDraggingTab(tab: DockableTabId | null, fromRail?: boolean): void;
  initializeSession(sessionId: string): void;
  moveTab(sessionId: string | undefined, tab: DockableTabId, panel: DockLocation): void;
  setActive(sessionId: string | undefined, panel: PanelId, tab: MainTabId): void;
  activateOrOpen(sessionId: string | undefined, tab: DockableTabId): void;
  revealTab(sessionId: string, tab: DockableTabId): void;
  revealFile(sessionId: string, path: string, line?: number): void;
  clearRevealRequest(nonce: number): void;
  requestDiffMode(sessionId: string, mode: GitDiffMode): void;
  clearDiffModeRequest(nonce: number): void;
  clearStaleDiffModeRequest(sessionId: string | null | undefined): void;
  clearStaleRevealRequest(sessionId: string | null | undefined): void;
  setTurnDiffSummary(sessionId: string, summary: TurnDiffSummary | null | undefined): void;
  setAutoLocation(tab: DockableTabId, panel: PanelId): void;
  setBottomHeight(sessionId: string | undefined, height: number): void;
  setBottomCollapsed(sessionId: string | undefined, collapsed: boolean): void;
  setRightVisible(sessionId: string | undefined, visible: boolean): void;
  openDefaultRightTool(sessionId: string | undefined, isAvailable?: (tab: DockableTabId) => boolean): void;
  resetLayout(sessionId: string | undefined): void;
}

export interface RevealRequest {
  sessionId: string;
  path: string;
  line?: number;
  nonce: number;
}

export interface DiffModeRequest {
  sessionId: string;
  mode: GitDiffMode;
  nonce: number;
}

export interface TurnDiffSummary {
  files: number;
  added: number;
  deleted: number;
}

export type PanelStore = PersistedPanelState & PanelActions & {
  legacySession: SessionPanelState | null;
  draggingTab: DockableTabId | null;
  dragFromRail: boolean;
  revealRequest: RevealRequest | null;
  diffModeRequest: DiffModeRequest | null;
  turnDiffSummaryBySession: Record<string, TurnDiffSummary | null>;
};

export const usePanelStore = create<PanelStore>((set, get) => ({
  ...loadState(),
  draggingTab: null,
  dragFromRail: false,
  revealRequest: null,
  diffModeRequest: null,
  turnDiffSummaryBySession: {},

  setDraggingTab: (tab, fromRail = false) => {
    set({ draggingTab: tab, dragFromRail: tab !== null && fromRail });
  },

  initializeSession: (sessionId) => {
    const current = get();
    if (current.sessions[sessionId] || !current.legacySession) return;
    const sessions = { ...current.sessions, [sessionId]: current.legacySession };
    set({ sessions, legacySession: null });
    persist({ autoLocation: current.autoLocation, sessions });
  },

  moveTab: (sessionId, tab, panel) => {
    if (!sessionId) return;
    const store = get();
    const next = moveState(panelFor(store, sessionId), tab, panel);
    const sessions = { ...store.sessions, [sessionId]: next };
    set({ sessions, legacySession: null });
    persist({ autoLocation: store.autoLocation, sessions });
  },

  setActive: (sessionId, panel, tab) => {
    if (!sessionId) return;
    const store = get();
    const current = panelFor(store, sessionId);
    if (panel === "main") {
      if (tab !== "chat" && current.dockByTab[tab] !== "main") return;
      const next = { ...current, activeMain: tab };
      const sessions = { ...store.sessions, [sessionId]: next };
      set({ sessions, legacySession: null });
      persist({ autoLocation: store.autoLocation, sessions });
      return;
    }
    if (current.dockByTab[tab as DockableTabId] !== panel) return;
    const next = {
      ...current,
      activeRight: panel === "right" ? (tab as DockableTabId) : current.activeRight,
      activeBottom: panel === "bottom" ? (tab as DockableTabId) : current.activeBottom
    };
    const sessions = { ...store.sessions, [sessionId]: next };
    set({ sessions, legacySession: null });
    persist({ autoLocation: store.autoLocation, sessions });
  },

  activateOrOpen: (sessionId, tab) => {
    const current = get();
    const panel = panelFor(current, sessionId);
    if (panel.dockByTab[tab] === "closed") {
      current.moveTab(sessionId, tab, current.autoLocation[tab] ?? "right");
    } else {
      current.setActive(sessionId, panel.dockByTab[tab], tab);
    }
  },

  revealTab: (sessionId, tab) => {
    get().activateOrOpen(sessionId, tab);
    const current = get();
    const panel = panelFor(current, sessionId);
    if (panel.dockByTab[tab] === "right") current.setRightVisible(sessionId, true);
    if (panel.dockByTab[tab] === "bottom" && panel.bottomCollapsed) current.setBottomCollapsed(sessionId, false);
  },

  revealFile: (sessionId, path, line) => {
    revealNonce += 1;
    set({ revealRequest: { sessionId, path, line, nonce: revealNonce } });
    get().revealTab(sessionId, "files");
  },

  clearRevealRequest: (nonce) => {
    if (get().revealRequest?.nonce === nonce) set({ revealRequest: null });
  },

  requestDiffMode: (sessionId, mode) => {
    diffModeNonce += 1;
    set({ diffModeRequest: { sessionId, mode, nonce: diffModeNonce } });
    get().revealTab(sessionId, "diff");
  },

  clearDiffModeRequest: (nonce) => {
    if (get().diffModeRequest?.nonce === nonce) set({ diffModeRequest: null });
  },

  clearStaleDiffModeRequest: (sessionId) => {
    const request = get().diffModeRequest;
    if (request && request.sessionId !== sessionId) set({ diffModeRequest: null });
  },

  clearStaleRevealRequest: (sessionId) => {
    const request = get().revealRequest;
    if (request && request.sessionId !== sessionId) set({ revealRequest: null });
  },

  setTurnDiffSummary: (sessionId, summary) => {
    const current = get().turnDiffSummaryBySession;
    if (summary === undefined) {
      if (!(sessionId in current)) return;
      set({ turnDiffSummaryBySession: Object.fromEntries(Object.entries(current).filter(([id]) => id !== sessionId)) });
      return;
    }
    const previous = current[sessionId];
    const unchanged =
      sessionId in current &&
      (previous === null
        ? summary === null
        : summary !== null && previous.files === summary.files && previous.added === summary.added && previous.deleted === summary.deleted);
    if (unchanged) return;
    set({ turnDiffSummaryBySession: { ...current, [sessionId]: summary } });
  },

  setAutoLocation: (tab, panel) => {
    const current = get();
    const autoLocation = { ...current.autoLocation, [tab]: panel };
    set({ autoLocation });
    persist({ autoLocation, sessions: current.sessions, legacySession: current.legacySession });
  },

  setBottomHeight: (sessionId, height) => {
    if (!sessionId) return;
    const store = get();
    const current = panelFor(store, sessionId);
    const next = { ...current, bottomHeight: clampBottomHeight(height) };
    const sessions = { ...store.sessions, [sessionId]: next };
    set({ sessions, legacySession: null });
    persist({ autoLocation: store.autoLocation, sessions });
  },

  setBottomCollapsed: (sessionId, collapsed) => {
    if (!sessionId) return;
    const store = get();
    const current = panelFor(store, sessionId);
    const sessions = { ...store.sessions, [sessionId]: { ...current, bottomCollapsed: collapsed } };
    set({ sessions, legacySession: null });
    persist({ autoLocation: store.autoLocation, sessions });
  },

  setRightVisible: (sessionId, visible) => {
    if (!sessionId) return;
    const store = get();
    const current = panelFor(store, sessionId);
    const sessions = { ...store.sessions, [sessionId]: { ...current, rightVisible: visible } };
    set({ sessions, legacySession: null });
    persist({ autoLocation: store.autoLocation, sessions });
  },

  openDefaultRightTool: (sessionId, isAvailable) => {
    if (!sessionId) return;
    const store = get();
    if (needsDefaultRightTool(panelFor(store, sessionId), isAvailable)) store.moveTab(sessionId, DEFAULT_RIGHT_TOOL, "right");
  },

  resetLayout: (sessionId) => {
    if (!sessionId) return;
    const store = get();
    const sessions = { ...store.sessions, [sessionId]: defaultSessionPanel() };
    set({ sessions, legacySession: null });
    persist({ autoLocation: store.autoLocation, sessions });
    get().openDefaultRightTool(sessionId);
  }
}));

export function selectSessionPanel(state: PanelStore, sessionId: string | undefined): SessionPanelState {
  if (!sessionId) return DEFAULT_SESSION_PANEL;
  return state.sessions[sessionId] ?? state.legacySession ?? DEFAULT_SESSION_PANEL;
}

export function selectTabsIn(state: PanelStore, sessionId: string | undefined, panel: PanelId): DockableTabId[] {
  return tabsInPanel(selectSessionPanel(state, sessionId).dockByTab, panel);
}
