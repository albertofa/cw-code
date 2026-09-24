import { ChevronDown, ChevronUp } from "lucide-react";
import { useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { DockableTabId } from "@cw-code/contracts";
import type { DriverName } from "../cw.js";
import { TOOL_TABS, isToolTabAvailable } from "./toolTabs.js";
import { ToolContent } from "./ToolContent.js";
import { useTabMenu } from "./TabMenu.js";
import { endTabDrag, startTabDrag, useDockDrop } from "./useDockDrop.js";
import { BOTTOM_HEIGHT_DEFAULT, tabsInPanel } from "../stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";

export function BottomPanel({ sessionId, driver, hasPr }: { sessionId: string; driver: DriverName | undefined; hasPr: boolean }) {
  const { dockByTab, activeBottom, bottomHeight, bottomCollapsed } = usePanelStore((s) => selectSessionPanel(s, sessionId));
  const setActive = usePanelStore((s) => s.setActive);
  const moveTab = usePanelStore((s) => s.moveTab);
  const setBottomHeight = usePanelStore((s) => s.setBottomHeight);
  const dropBottom = useDockDrop("bottom", sessionId);
  const tabMenu = useTabMenu(sessionId);
  const draggingTab = usePanelStore((s) => s.draggingTab);
  const setBottomCollapsed = usePanelStore((s) => s.setBottomCollapsed);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const tabs = tabsInPanel(dockByTab, "bottom").filter((id) => {
    const def = TOOL_TABS.find((item) => item.id === id);
    return def !== undefined && isToolTabAvailable(def, driver, hasPr);
  });
  const effectiveActive: DockableTabId | null = tabs.includes(activeBottom) ? activeBottom : (tabs[0] ?? null);

  const onResizeStart = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startHeight: bottomHeight };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setBottomHeight(sessionId, d.startHeight + (d.startY - ev.clientY));
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <section
      className={`bottom-panel${dropBottom.over || draggingTab !== null ? " drop-target-active" : ""}`}
      style={tabs.length === 0 || bottomCollapsed ? undefined : { height: bottomHeight }}
      aria-label="Bottom panel"
      {...dropBottom.bind}
    >
      {tabs.length === 0 ? (
        <div className="bottom-empty">Drop a tab here to dock it below the composer</div>
      ) : (
      <>
      {!bottomCollapsed && (
      <div
        className="bottom-resizer"
        onMouseDown={onResizeStart}
        onDoubleClick={() => setBottomHeight(sessionId, BOTTOM_HEIGHT_DEFAULT)}
        title="Drag to resize - double-click to reset"
      />
      )}
      <div
        className="bottom-tabbar"
        role="tablist"
        aria-label="Bottom panel tabs"
        {...dropBottom.bind}
      >
        {tabs.map((id) => {
          const def = TOOL_TABS.find((item) => item.id === id);
          if (!def) return null;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={effectiveActive === id}
              onClick={() => {
                setActive(sessionId, "bottom", id);
                if (bottomCollapsed) setBottomCollapsed(sessionId, false);
              }}
              onContextMenu={tabMenu.onTabContextMenu(id)}
              draggable
              onDragStart={(e) => startTabDrag(e, id, sessionId)}
              onDragEnd={endTabDrag}
              className={`tab${effectiveActive === id ? " active" : ""}`}
              title={`${def.title} - drag to move, right-click for more actions`}
            >
              <def.Icon size={14} className={`tab-icon${def.driver ? ` driver-icon ${def.driver}` : ""}`} aria-hidden="true" />
              <span
                className="tab-x"
                role="button"
                aria-label={`Close ${def.title}`}
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  moveTab(sessionId, id, "closed");
                }}
              >
                &times;
              </span>
              <span className="tab-label">{def.title}</span>
            </button>
          );
        })}
        <button
          className="icon-btn bottom-min"
          onClick={() => setBottomCollapsed(sessionId, !bottomCollapsed)}
          title={bottomCollapsed ? "Expand panel" : "Minimize panel"}
          aria-label={bottomCollapsed ? "Expand bottom panel" : "Minimize bottom panel"}
          aria-expanded={!bottomCollapsed}
        >
          {bottomCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      {!bottomCollapsed && (
      <div
        className="bottom-body"
        {...dropBottom.bind}
      >
        {effectiveActive !== null && <ToolContent tab={effectiveActive} sessionId={sessionId} panel="bottom" />}
      </div>
      )}
      </>
      )}
      {tabMenu.menuNode}
    </section>
  );
}