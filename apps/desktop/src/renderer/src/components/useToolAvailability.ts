import type { DockableTabId } from "@cw-code/contracts";
import type { DriverName } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { resolveRightTop } from "../stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";
import { sessionLinks } from "./sessionPrLinks.js";
import { TOOL_TABS, isToolTabAvailable } from "./toolTabs.js";

export interface ToolAvailability {
  driver: DriverName | undefined;
  hasPr: boolean;
  hasPreview: boolean;
  isToolAvailable: (tab: DockableTabId) => boolean;
  rightTop: DockableTabId | null;
}

export function useToolAvailability(sessionId: string | undefined): ToolAvailability {
  const pendingDriver = useAppStore((s) => s.pendingDriver);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const hasPreview = useAppStore((s) => (sessionId ? (s.previewBySession[sessionId] ?? null) !== null : false));
  const { dockByTab, activeRight } = usePanelStore((s) => selectSessionPanel(s, sessionId));

  const session = Object.values(sessionsByProject).flat().find((item) => item.id === sessionId);
  const driver = pendingDriver ?? session?.driver;
  const hasPr = pendingDriver === null && sessionLinks(session).length > 0;

  const isToolAvailable = (tab: DockableTabId): boolean => {
    if (tab === "preview") return hasPreview;
    const def = TOOL_TABS.find((item) => item.id === tab);
    return def !== undefined && isToolTabAvailable(def, driver, hasPr);
  };

  const rightTop = resolveRightTop(dockByTab, activeRight, isToolAvailable, driver);
  return { driver, hasPr, hasPreview, isToolAvailable, rightTop };
}
