import { create } from "zustand";
import type { DockableTabId, DockLocation, MainTabId, PanelId } from "@cw-code/contracts";
import {
  PANEL_LAYOUT_KEY,
  PANEL_STATE_KEY,
  clampBottomHeight,
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

export interface PanelActions {
  setDraggingTab(tab: DockableTabId | null): void;
  initializeSession(sessionId: string): void;
  moveTab(sessionId: string | undefined, tab: DockableTabId, panel: DockLocation): void;
  setActive(sessionId: string | undefined, panel: PanelId, tab: MainTabId): void;
  activateOrOpen(sessionId: string | undefined, tab: DockableTabId): void;
  revealTab(sessionId: string, tab: DockableTabId): void;
  setAutoLocation(tab: DockableTabId, panel: PanelId): void;
  setBottomHeight(sessionId: string | undefined, height: number): void;
  setBottomCollapsed(sessionId: string | undefined, collapsed: boolean): void;
  setRightVisible(sessionId: string | undefined, visible: boolean): void;
  resetLayout(sessionId: string | undefined): void;
}

export type PanelStore = PersistedPanelState & PanelActions & {
  legacySession: SessionPanelState | null;
  draggingTab: DockableTabId | null;
};

export const usePanelStore = create<PanelStore>((set, get) => ({
  ...loadState(),
  draggingTab: null,

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
    const current = panelFor(store, sessionId);
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
    const next = sanitizeSessionPanel({
      ...current,
      dockByTab,
      activeMain,
      activeRight,
      activeBottom,
      mainOrder
    });
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
