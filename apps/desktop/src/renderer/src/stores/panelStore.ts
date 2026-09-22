import { create } from "zustand";
import type { DockableTabId, DockLocation, MainTabId, PanelId, PanelLayoutSnapshot } from "@cw-code/contracts";
import {
  PANEL_LAYOUT_KEY,
  clampBottomHeight,
  defaultLayout,
  parseLayout,
  sanitizeLayout,
  serializeLayout,
  tabsInPanel
} from "./panelLayout.js";

function loadSnapshot(): PanelLayoutSnapshot {
  try {
    return parseLayout(window.localStorage.getItem(PANEL_LAYOUT_KEY));
  } catch {
    return defaultLayout();
  }
}

function persist(snapshot: PanelLayoutSnapshot): void {
  try {
    window.localStorage.setItem(PANEL_LAYOUT_KEY, serializeLayout(snapshot));
  } catch {
  }
}

export interface PanelActions {
  setDraggingTab(tab: DockableTabId | null): void;
  moveTab(tab: DockableTabId, panel: DockLocation): void;
  setActive(panel: PanelId, tab: MainTabId): void;
  activateOrOpen(tab: DockableTabId): void;
  setAutoLocation(tab: DockableTabId, panel: PanelId): void;
  setBottomHeight(height: number): void;
  setBottomCollapsed(collapsed: boolean): void;
  setRightVisible(visible: boolean): void;
  resetLayout(): void;
}

export type PanelStore = PanelLayoutSnapshot & PanelActions & { draggingTab: DockableTabId | null; bottomCollapsed: boolean; rightVisible: boolean };

function snapshotOf(state: PanelStore): PanelLayoutSnapshot {
  return {
    dockByTab: state.dockByTab,
    autoLocation: state.autoLocation,
    activeMain: state.activeMain,
    activeRight: state.activeRight,
    activeBottom: state.activeBottom,
    mainOrder: state.mainOrder,
    bottomHeight: state.bottomHeight
  };
}

export const usePanelStore = create<PanelStore>((set, get) => ({
  ...loadSnapshot(),
  draggingTab: null,
  bottomCollapsed: false,
  rightVisible: true,

  setDraggingTab: (tab) => {
    set({ draggingTab: tab });
  },

  moveTab: (tab, panel) => {
    const current = get();
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
    const next: PanelLayoutSnapshot = sanitizeLayout({
      dockByTab,
      autoLocation: current.autoLocation,
      activeMain,
      activeRight,
      activeBottom,
      mainOrder,
      bottomHeight: current.bottomHeight
    });
    set(next);
    persist(next);
  },

  setActive: (panel, tab) => {
    const current = get();
    if (panel === "main") {
      if (tab !== "chat" && current.dockByTab[tab] !== "main") return;
      const next = { ...snapshotOf(current), activeMain: tab };
      set(next);
      persist(next);
      return;
    }
    if (current.dockByTab[tab as DockableTabId] !== panel) return;
    const next = {
      ...snapshotOf(current),
      activeRight: panel === "right" ? (tab as DockableTabId) : current.activeRight,
      activeBottom: panel === "bottom" ? (tab as DockableTabId) : current.activeBottom
    };
    set(next);
    persist(next);
  },

  activateOrOpen: (tab) => {
    const current = get();
    const docked = current.dockByTab[tab];
    if (docked === "closed") {
      current.moveTab(tab, current.autoLocation[tab] ?? "right");
    } else {
      current.setActive(docked, tab);
    }
  },

  setAutoLocation: (tab, panel) => {
    const current = get();
    const next = { ...snapshotOf(current), autoLocation: { ...current.autoLocation, [tab]: panel } };
    set(next);
    persist(next);
  },

  setBottomHeight: (height) => {
    const current = get();
    const next = { ...snapshotOf(current), bottomHeight: clampBottomHeight(height) };
    set(next);
    persist(next);
  },

  setBottomCollapsed: (collapsed) => {
    set({ bottomCollapsed: collapsed });
  },

  setRightVisible: (visible) => {
    set({ rightVisible: visible });
  },

  resetLayout: () => {
    const next = defaultLayout();
    set(next);
    persist(next);
  }
}));

export function selectTabsIn(state: PanelStore, panel: PanelId): DockableTabId[] {
  return tabsInPanel(state.dockByTab, panel);
}