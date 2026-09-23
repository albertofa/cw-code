import { MessageSquare } from "lucide-react";
import type { DockableTabId, MainTabId } from "@cw-code/contracts";
import type { DriverName } from "../cw.js";
import { DriverIcon } from "./DriverIcon.js";
import { TOOL_TABS, harnessLabel } from "./toolTabs.js";
import { useTabMenu } from "./TabMenu.js";
import { endTabDrag, startTabDrag, useDockDrop } from "./useDockDrop.js";
import { resolveMainTab } from "../stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";

export function MainTabStrip({ sessionId, driver }: { sessionId: string | undefined; driver: DriverName | undefined }) {
  const { mainOrder, activeMain, dockByTab } = usePanelStore((s) => selectSessionPanel(s, sessionId));
  const setActive = usePanelStore((s) => s.setActive);
  const moveTab = usePanelStore((s) => s.moveTab);
  const dropMain = useDockDrop("main", sessionId);
  const tabMenu = useTabMenu(sessionId);
  const draggingTab = usePanelStore((s) => s.draggingTab);

  const effectiveActive: MainTabId =
    sessionId === undefined ? "chat" : resolveMainTab(mainOrder, dockByTab, driver, activeMain);
  const chatLabel = driver === undefined ? "Chat" : harnessLabel(driver);

  return (
    <div
      className={`main-tabbar${dropMain.over || draggingTab !== null ? " drop-target-active" : ""}`}
      role="tablist"
      aria-label="Main panel tabs"
      {...dropMain.bind}
    >
      <button
        role="tab"
        aria-selected={effectiveActive === "chat"}
        onClick={() => setActive(sessionId, "main", "chat")}
        className={`tab fixed${effectiveActive === "chat" ? " active" : ""}`}
        title={`${chatLabel} - composer and output (fixed tab)`}
      >
        {driver !== undefined ? <DriverIcon driver={driver} size={15} /> : <MessageSquare size={15} />}
        <span className="tab-label">{chatLabel}</span>
      </button>
      {sessionId !== undefined &&
        mainOrder.map((id) => {
          if (id === "chat") return null;
          if (dockByTab[id] !== "main") return null;
          const def = TOOL_TABS.find((item) => item.id === id);
          if (!def) return null;
          if (def.driver !== undefined && def.driver !== driver) return null;
          const tabId = id as DockableTabId;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={effectiveActive === id}
              onClick={() => setActive(sessionId, "main", tabId)}
              onContextMenu={tabMenu.onTabContextMenu(tabId)}
              draggable
              onDragStart={(e) => startTabDrag(e, tabId, sessionId)}
              onDragEnd={endTabDrag}
              className={`tab${effectiveActive === id ? " active" : ""}`}
              title={`${def.title} - drag to move, right-click for more actions`}
            >
              <def.Icon size={15} className={`tab-icon${def.driver ? ` driver-icon ${def.driver}` : ""}`} aria-hidden="true" />
              <span
                className="tab-x"
                role="button"
                aria-label={`Close ${def.title}`}
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  moveTab(sessionId, tabId, "closed");
                }}
              >
                &times;
              </span>
              <span className="tab-label">{def.title}</span>
            </button>
          );
        })}
      {tabMenu.menuNode}
    </div>
  );
}