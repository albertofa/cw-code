import { MessageSquare } from "lucide-react";
import type { MainTabId } from "@cw-code/contracts";
import type { DriverName } from "../cw.js";
import { DockTab } from "./DockTab.js";
import { DriverIcon } from "./DriverIcon.js";
import { focusSiblingTab } from "./tabStripKeys.js";
import { harnessLabel, toolAvailability } from "./toolTabs.js";
import { useTabMenu } from "./TabMenu.js";
import { useDockDrop } from "./useDockDrop.js";
import { resolveMainTab } from "../stores/panelLayout.js";
import { useAppStore } from "../stores/appStore.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";

export function MainTabStrip({
  sessionId,
  driver,
  hasPr
}: {
  sessionId: string | undefined;
  driver: DriverName | undefined;
  hasPr: boolean;
}) {
  const { mainOrder, activeMain, dockByTab } = usePanelStore((s) => selectSessionPanel(s, sessionId));
  const setActive = usePanelStore((s) => s.setActive);
  const moveTab = usePanelStore((s) => s.moveTab);
  const dropMain = useDockDrop("main", sessionId);
  const tabMenu = useTabMenu(sessionId);
  const draggingTab = usePanelStore((s) => s.draggingTab);
  const hasPreview = useAppStore((s) => (sessionId ? (s.previewBySession[sessionId] ?? null) !== null : false));
  const isToolAvailable = toolAvailability(driver, hasPr, hasPreview);

  const effectiveActive: MainTabId =
    sessionId === undefined ? "chat" : resolveMainTab(mainOrder, dockByTab, driver, activeMain, hasPr, isToolAvailable);
  const chatLabel = driver === undefined ? "Chat" : harnessLabel(driver);

  return (
    <div
      className={`main-tabbar${dropMain.over || draggingTab !== null ? " drop-target-active" : ""}`}
      role="tablist"
      aria-label="Main panel tabs"
      onKeyDown={focusSiblingTab}
      {...dropMain.bind}
    >
      <button
        role="tab"
        aria-selected={effectiveActive === "chat"}
        tabIndex={effectiveActive === "chat" ? 0 : -1}
        onClick={() => setActive(sessionId, "main", "chat")}
        className={`tab fixed${effectiveActive === "chat" ? " active" : ""}`}
        title={`${chatLabel} - composer and output (fixed tab)`}
      >
        {driver !== undefined ? <DriverIcon driver={driver} size={15} /> : <MessageSquare size={15} />}
        <span className="tab-label">{chatLabel}</span>
      </button>
      {sessionId !== undefined &&
        mainOrder.map((id) => {
          if (id === "chat" || dockByTab[id] !== "main" || !isToolAvailable(id)) return null;
          return (
            <DockTab
              key={id}
              tab={id}
              sessionId={sessionId}
              active={effectiveActive === id}
              onActivate={() => setActive(sessionId, "main", id)}
              onContextMenu={tabMenu.onTabContextMenu(id)}
              onClose={() => moveTab(sessionId, id, "closed")}
            />
          );
        })}
      {tabMenu.menuNode}
    </div>
  );
}
