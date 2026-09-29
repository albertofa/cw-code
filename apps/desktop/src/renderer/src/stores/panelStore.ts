import { create } from "zustand";
import type { DockableTabId, DockLocation, GitDiffMode, MainTabId, PanelId } from "@cw-code/contracts";
import {
  PANEL_LAYOUT_KEY,
  PANEL_STATE_KEY,
  clampBottomHeight,
  clampSplitRatio,
  defaultSessionPanel,
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
  let rightSplit = current.rightSplit;
  if (panel === "right") {
    activeRight = tab;
    if (rightSplit === tab) rightSplit = current.activeRight;
  } else if (dockByTab[activeRight] !== "right") {
    const promoted = rightSplit !== null && dockByTab[rightSplit] === "right" ? rightSplit : null;
    activeRight = promoted ?? tabsInPanel(dockByTab, "right")[0] ?? activeRight;
  }
  let activeBottom = current.activeBottom;
  if (panel === "bottom") {
    activeBottom = tab;
  } else if (dockByTab[activeBottom] !== "bottom") {
    activeBottom = tabsInPanel(dockByTab, "bottom")[0] ?? activeBottom;
  }
  return sanitizeSessionPanel({ ...current, dockByTab, activeMain, activeRight, activeBottom, mainOrder, rightSplit });
}

export interface PanelActions {
  setDraggingTab(tab: DockableTabId | null): void;
  initializeSession(sessionId: string): void;
  moveTab(sessionId: string | undefined, tab: DockableTabId, panel: DockLocation): void;
  setActive(sessionId: string | undefined, panel: PanelId, tab: MainTabId): void;
  activateOrOpen(sessionId: string | undefined, tab: DockableTabId): void;
  revealTab(sessionId: string, tab: DockableTabId): void;
  revealFile(sessionId: string, path: string, line?: number): void;
  clearRevealRequest(nonce: number): void;
  requestDiffMode(sessionId: string, mode: GitDiffMode): void;
  clearDiffModeRequest(nonce: number): void;
  setAutoLocation(tab: DockableTabId, panel: PanelId): void;
  setBottomHeight(sessionId: string | undefined, height: number): void;
  setBottomCollapsed(sessionId: string | undefined, collapsed: boolean): void;
  setRightVisible(sessionId: string | undefined, visible: boolean): void;
  setRightSplit(sessionId: string | undefined, tab: DockableTabId | null): void;
  setRightSplitRatio(sessionId: string | undefined, ratio: number): void;
  toggleRightSplit(sessionId: string | undefined, isAvailable?: (tab: DockableTabId) => boolean): void;
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

export type PanelStore = PersistedPanelState & PanelActions & {
  legacySession: SessionPanelState | null;
  draggingTab: DockableTabId | null;
  revealRequest: RevealRequest | null;
  diffModeRequest: DiffModeRequest | null;
};

export const usePanelStore = create<PanelStore>((set, get) => ({
  ...loadState(),
  draggingTab: null,
  revealRequest: null,
  diffModeRequest: null,

  setDraggingTab: (tab) => {
    set({ draggingTab: tab });
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
      activeBottom: panel === "bottom" ? (tab as DockableTabId) : current.activeBottom,
      rightSplit: panel === "right" && current.rightSplit === tab ? current.activeRight : current.rightSplit
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

  setRightSplit: (sessionId, tab) => {
    if (!sessionId) return;
    const store = get();
    const current = panelFor(store, sessionId);
    let base = current;
    if (tab !== null && current.dockByTab[tab] !== "right") {
      base = moveState(current, tab, "right");
      if (current.dockByTab[current.activeRight] === "right") base = { ...base, activeRight: current.activeRight };
    }
    const next = sanitizeSessionPanel({
      ...base,
      rightSplit: tab,
      rightVisible: tab === null ? base.rightVisible : true
    });
    const sessions = { ...store.sessions, [sessionId]: next };
    set({ sessions, legacySession: null });
    persist({ autoLocation: store.autoLocation, sessions });
  },

  setRightSplitRatio: (sessionId, ratio) => {
    if (!sessionId) return;
    const store = get();
    const current = panelFor(store, sessionId);
    const sessions = { ...store.sessions, [sessionId]: { ...current, rightSplitRatio: clampSplitRatio(ratio) } };
    set({ sessions, legacySession: null });
    persist({ autoLocation: store.autoLocation, sessions });
  },

  toggleRightSplit: (sessionId, isAvailable = () => true) => {
    if (!sessionId) return;
    const store = get();
    const current = panelFor(store, sessionId);
    const splitShowing = current.rightSplit !== null && isAvailable(current.rightSplit);
    if (splitShowing && current.rightVisible) {
      store.setRightSplit(sessionId, null);
      return;
    }
    if (splitShowing) {
      store.setRightSplit(sessionId, current.rightSplit);
      return;
    }
    const other = tabsInPanel(current.dockByTab, "right").find((tab) => tab !== current.activeRight && isAvailable(tab));
    store.setRightSplit(sessionId, other ?? (current.activeRight === "shell" ? "files" : "shell"));
  },

  setRightVisible: (sessionId, visible) => {
    if (!sessionId) return;
    const store = get();
    const current = panelFor(store, sessionId);
    const sessions = { ...store.sessions, [sessionId]: { ...current, rightVisible: visible } };
    set({ sessions, legacySession: null });
    persist({ autoLocation: store.autoLocation, sessions });
  },

  resetLayout: (sessionId) => {
    if (!sessionId) return;
    const store = get();
    const sessions = { ...store.sessions, [sessionId]: defaultSessionPanel() };
    set({ sessions, legacySession: null });
    persist({ autoLocation: store.autoLocation, sessions });
  }
}));

export function selectSessionPanel(state: PanelStore, sessionId: string | undefined): SessionPanelState {
  if (!sessionId) return DEFAULT_SESSION_PANEL;
  return state.sessions[sessionId] ?? state.legacySession ?? DEFAULT_SESSION_PANEL;
}

export function selectTabsIn(state: PanelStore, sessionId: string | undefined, panel: PanelId): DockableTabId[] {
  return tabsInPanel(selectSessionPanel(state, sessionId).dockByTab, panel);
}
