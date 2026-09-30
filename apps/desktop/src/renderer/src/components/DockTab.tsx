import type { MouseEvent as ReactMouseEvent } from "react";
import { Rows2 } from "lucide-react";
import type { DockableTabId } from "@cw-code/contracts";
import { DriverIcon } from "./DriverIcon.js";
import { TOOL_TABS, isHarnessTabId } from "./toolTabs.js";
import { endTabDrag, startTabDrag } from "./useDockDrop.js";
import "./toolRail.css";

export function DockTab({
  tab,
  sessionId,
  active,
  marker,
  iconSize = 15,
  onActivate,
  onContextMenu,
  onClose
}: {
  tab: DockableTabId;
  sessionId: string | undefined;
  active: boolean;
  marker?: "split";
  iconSize?: number;
  onActivate: () => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
  onClose: () => void;
}) {
  const def = TOOL_TABS.find((item) => item.id === tab);
  if (!def) return null;
  const name = marker === "split" ? `${def.title} (split)` : def.title;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onActivate}
      onContextMenu={onContextMenu}
      onDoubleClick={(e) => e.stopPropagation()}
      draggable
      onDragStart={(e) => startTabDrag(e, tab, sessionId)}
      onDragEnd={endTabDrag}
      className={`tab${active ? " active" : ""}${marker === "split" ? " split" : ""}`}
      data-tool={tab}
      title={`${name} - drag to move, right-click for more actions`}
      aria-label={name}
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
        role="button"
        aria-label={`Close ${def.title}`}
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        &times;
      </span>
      <span className="tab-label">{def.title}</span>
      {marker === "split" && <Rows2 size={11} className="tab-mark" aria-hidden="true" />}
    </button>
  );
}
