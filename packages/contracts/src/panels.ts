import type { DriverKind } from "./session.js";

export type PanelId = "main" | "right" | "bottom";

export type DockLocation = PanelId | "closed";

export type DockableTabId = "files" | "agents" | "diff" | DriverKind | "shell" | "preview";

export type MainTabId = "chat" | DockableTabId;

export type TabDockState = Record<DockableTabId, DockLocation>;

export type TabAutoLocation = Record<DockableTabId, PanelId>;

export interface PanelLayoutSnapshot {
  dockByTab: TabDockState;
  autoLocation: TabAutoLocation;
  activeMain: MainTabId;
  activeRight: DockableTabId;
  activeBottom: DockableTabId;
  mainOrder: MainTabId[];
  bottomHeight: number;
}