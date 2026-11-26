import type { DockableTabId } from "@cw-code/contracts";
import type { DriverName } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { resolveRightTop } from "../stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";
import { useSessionRow } from "./useSessions.js";
import { toolAvailability } from "./toolTabs.js";

export interface ToolAvailability {
  driver: DriverName | undefined;
  hasPreview: boolean;
  isToolAvailable: (tab: DockableTabId) => boolean;
  rightTop: DockableTabId | null;
}

export function useToolAvailability(sessionId: string | undefined): ToolAvailability {
  const pendingDriver = useAppStore((s) => s.pendingDriver);
  const hasPreview = useAppStore((s) => (sessionId ? (s.previewBySession[sessionId] ?? null) !== null : false));
  const { dockByTab, activeRight } = usePanelStore((s) => selectSessionPanel(s, sessionId));

  const session = useSessionRow(sessionId)?.session;
  const driver = pendingDriver ?? session?.driver;

  const isToolAvailable = toolAvailability(driver, hasPreview);
  const rightTop = resolveRightTop(dockByTab, activeRight, isToolAvailable, driver);
  return { driver, hasPreview, isToolAvailable, rightTop };
}
