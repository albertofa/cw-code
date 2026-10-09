import type { MouseEvent as ReactMouseEvent } from "react";
import type { DockableTabId } from "@cw-code/contracts";
import { DriverIcon } from "./DriverIcon.js";
import { closeTabOnKey } from "./tabStripKeys.js";
import { TOOL_TABS, isHarnessTabId } from "./toolTabs.js";
import { endTabDrag, startTabDrag } from "./useDockDrop.js";
import "./toolRail.css";

export function DockTab({
  tab,
  sessionId,
  active,
  id,
  controls,
  iconSize = 15,
  onActivate,
  onContextMenu,
  onClose
}: {
  tab: DockableTabId;
  sessionId: string | undefined;
  active: boolean;
  id?: string;
  controls?: string;
  iconSize?: number;
  onActivate: () => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
  onClose: () => void;
}) {
  const def = TOOL_TABS.find((item) => item.id === tab);
  if (!def) return null;

  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-controls={controls}
      aria-selected={active}
      aria-keyshortcuts="Delete"
      tabIndex={active ? 0 : -1}
      onClick={onActivate}
      onKeyDown={(e) => closeTabOnKey(e, onClose)}
      onContextMenu={onContextMenu}
      onDoubleClick={(e) => e.stopPropagation()}
      draggable
      onDragStart={(e) => startTabDrag(e, tab, sessionId)}
      onDragEnd={endTabDrag}
      className={`tab${active ? " active" : ""}`}
      data-tool={tab}
      title={`${def.title} - drag to move, Delete to close, right-click for more actions`}
      aria-label={def.title}
    >
      {isHarnessTabId(tab) ? (
        <span className="tab-icon tab-driver" aria-hidden="true">
          <DriverIcon driver={tab} size={iconSize} />
        </span>
      ) : (
        <def.Icon size={iconSize} className="tab-icon" aria-hidden="true" />
      )}
      <span
        className="tab-x"
        aria-hidden="true"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        &times;
      </span>
      <span className="tab-label">{def.title}</span>
    </button>
  );
}
