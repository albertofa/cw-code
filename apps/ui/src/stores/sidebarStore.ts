import { create } from "zustand";

const STORAGE_KEY = "cw-code:sidebarCollapsed";

function loadCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function storeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn(`[layout] could not persist ${STORAGE_KEY}`, err);
  }
}

interface SidebarState {
  collapsed: boolean;
  setCollapsed(collapsed: boolean): void;
  toggle(): void;
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  collapsed: loadCollapsed(),
  setCollapsed: (collapsed) => {
    if (get().collapsed === collapsed) return;
    storeCollapsed(collapsed);
    set({ collapsed });
  },
  toggle: () => get().setCollapsed(!get().collapsed)
}));
