import { useId, type MouseEvent as ReactMouseEvent } from "react";
import type { DockableTabId } from "@cw-code/contracts";
import { PaneTabsHeader, rightTabId } from "./PaneHeader.js";
import { ToolContent } from "./ToolContent.js";
import "./toolRail.css";

export function RightPanelBody({
  sessionId,
  tabs,
  top,
  onToolMenu,
  onToolContextMenu
}: {
  sessionId: string;
  tabs: DockableTabId[];
  top: DockableTabId;
  onToolMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => void;
  onToolContextMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => void;
}) {
  const idBase = useId();
  const panelId = `${idBase}-panel`;

  return (
    <div className="right-body">
      <PaneTabsHeader
        sessionId={sessionId}
        tabs={tabs}
        top={top}
        idBase={idBase}
        panelId={panelId}
        onDock={onToolMenu(top)}
        onTabContextMenu={onToolContextMenu}
      />
      <div className="right-pane-body" key={top} id={panelId} role="tabpanel" aria-labelledby={rightTabId(idBase, top)}>
        <ToolContent tab={top} sessionId={sessionId} panel="right" />
      </div>
    </div>
  );
}
