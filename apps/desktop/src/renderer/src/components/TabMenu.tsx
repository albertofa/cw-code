import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { DockableTabId, PanelId } from "@cw-code/contracts";
import { AppWindow, PanelBottom, PanelRight, Pin, RotateCcw, Rows2, X, type LucideIcon } from "lucide-react";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";

const MENU_WIDTH = 240;
const MENU_HEIGHT = 260;

const PANELS: Array<{ id: PanelId; label: string; Icon: LucideIcon }> = [
  { id: "main", label: "Main", Icon: AppWindow },
  { id: "right", label: "Right", Icon: PanelRight },
  { id: "bottom", label: "Bottom", Icon: PanelBottom }
];

export function TabMenu({
  x,
  y,
  tab,
  sessionId,
  onClose
}: {
  x: number;
  y: number;
  tab: DockableTabId;
  sessionId: string | undefined;
  onClose: () => void;
}) {
  const moveTab = usePanelStore((s) => s.moveTab);
  const { dockByTab, activeRight, rightSplit } = usePanelStore((s) => selectSessionPanel(s, sessionId));
  const setRightSplit = usePanelStore((s) => s.setRightSplit);
  const setAutoLocation = usePanelStore((s) => s.setAutoLocation);
  const resetLayout = usePanelStore((s) => s.resetLayout);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointer = () => onClose();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);

  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT - 8));

  return (
    <div
      className="ctx-menu tab-menu"
      style={{ left, top }}
      role="menu"
      aria-label="Tab actions"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {PANELS.map(({ id: panel, label, Icon }) => (
        <button
          key={panel}
          className="ctx-item"
          role="menuitem"
          title={dockByTab[tab] === panel ? "Already docked here" : `Dock this tab in the ${label.toLowerCase()} panel`}
          onClick={() => {
            moveTab(sessionId, tab, panel);
            onClose();
          }}
        >
          <Icon size={14} aria-hidden="true" />
          <span>{`Open in ${label}${dockByTab[tab] === panel ? " (current)" : ""}`}</span>
        </button>
      ))}
      {rightSplit === tab ? (
        <button
          className="ctx-item"
          role="menuitem"
          title="Show a single tool in the right panel"
          onClick={() => {
            setRightSplit(sessionId, null);
            onClose();
          }}
        >
          <Rows2 size={14} aria-hidden="true" />
          <span>Close split</span>
        </button>
      ) : (
        !(dockByTab[tab] === "right" && activeRight === tab) && (
          <button
            className="ctx-item"
            role="menuitem"
            title="Show this tool below the active one in the right panel"
            onClick={() => {
              setRightSplit(sessionId, tab);
              onClose();
            }}
          >
            <Rows2 size={14} aria-hidden="true" />
            <span>Open in split</span>
          </button>
        )
      )}
      <button
        className="ctx-item"
        role="menuitem"
        title="Close this tab — reopen it any time from the right rail"
        onClick={() => {
          moveTab(sessionId, tab, "closed");
          onClose();
        }}
      >
        <X size={14} aria-hidden="true" />
        <span>Close tab</span>
      </button>
      <button
        className="ctx-item"
        role="menuitem"
        title="Right-rail clicks will open this tab here"
        onClick={() => {
          if (dockByTab[tab] !== "closed") setAutoLocation(tab, dockByTab[tab]);
          onClose();
        }}
      >
        <Pin size={14} aria-hidden="true" />
        <span>Always open here</span>
      </button>
      <button
        className="ctx-item"
        role="menuitem"
        title="Close every tab and restore defaults"
        onClick={() => {
          resetLayout(sessionId);
          onClose();
        }}
      >
        <RotateCcw size={14} aria-hidden="true" />
        <span>Reset layout</span>
      </button>
    </div>
  );
}

export function useTabMenu(sessionId: string | undefined): {
  menuNode: ReactNode;
  onTabContextMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => void;
  onTabMenuButton: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => void;
} {
  const [menu, setMenu] = useState<{ x: number; y: number; tab: DockableTabId; sessionId: string | undefined } | null>(null);
  useEffect(() => setMenu(null), [sessionId]);
  return {
    menuNode: menu ? (
      <TabMenu x={menu.x} y={menu.y} tab={menu.tab} sessionId={menu.sessionId} onClose={() => setMenu(null)} />
    ) : null,
    onTabContextMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, tab, sessionId });
    },
    onTabMenuButton: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setMenu({ x: rect.right - MENU_WIDTH, y: rect.bottom + 4, tab, sessionId });
    }
  };
}