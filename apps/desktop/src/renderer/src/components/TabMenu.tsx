import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { DockableTabId, PanelId } from "@cw-code/contracts";
import { AppWindow, PanelBottom, PanelRight, Pin, RotateCcw, X, type LucideIcon } from "lucide-react";
import { usePanelStore } from "../stores/panelStore.js";

const MENU_WIDTH = 240;
const MENU_HEIGHT = 220;

const PANELS: Array<{ id: PanelId; label: string; Icon: LucideIcon }> = [
  { id: "main", label: "Main", Icon: AppWindow },
  { id: "right", label: "Right", Icon: PanelRight },
  { id: "bottom", label: "Bottom", Icon: PanelBottom }
];

export function TabMenu({ x, y, tab, onClose }: { x: number; y: number; tab: DockableTabId; onClose: () => void }) {
  const moveTab = usePanelStore((s) => s.moveTab);
  const dockByTab = usePanelStore((s) => s.dockByTab);
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
            moveTab(tab, panel);
            onClose();
          }}
        >
          <Icon size={14} aria-hidden="true" />
          <span>{`Open in ${label}${dockByTab[tab] === panel ? " (current)" : ""}`}</span>
        </button>
      ))}
      <button
        className="ctx-item"
        role="menuitem"
        title="Close this tab — reopen it any time from the right rail"
        onClick={() => {
          moveTab(tab, "closed");
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
          resetLayout();
          onClose();
        }}
      >
        <RotateCcw size={14} aria-hidden="true" />
        <span>Reset layout</span>
      </button>
    </div>
  );
}

export function useTabMenu(): {
  menuNode: ReactNode;
  onTabContextMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => void;
} {
  const [menu, setMenu] = useState<{ x: number; y: number; tab: DockableTabId } | null>(null);
  return {
    menuNode: menu ? <TabMenu x={menu.x} y={menu.y} tab={menu.tab} onClose={() => setMenu(null)} /> : null,
    onTabContextMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, tab });
    }
  };
}