import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from "react";
import { PanelsTopLeft } from "lucide-react";
import type { DockableTabId } from "@cw-code/contracts";
import { useAppStore } from "../stores/appStore.js";
import { usePanelStore } from "../stores/panelStore.js";
import { DockTab } from "./DockTab.js";
import { toolTabTitle } from "./toolTabs.js";
import { paneDiffSummary } from "./railTools.js";
import { focusSiblingTab } from "./tabStripKeys.js";
import "./toolRail.css";

interface ScrollEdges {
  start: boolean;
  end: boolean;
}

function usePaneSummary(tab: DockableTabId, sessionId: string | undefined): string | undefined {
  const gitStatus = useAppStore((s) => (sessionId && tab === "diff" ? s.gitStatusBySession[sessionId] : undefined));
  const turnDiffSummary = usePanelStore((s) => (sessionId && tab === "diff" ? s.turnDiffSummaryBySession[sessionId] : undefined));
  return tab === "diff" ? paneDiffSummary(gitStatus, turnDiffSummary) : undefined;
}

function useScrollEdges(content: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<ScrollEdges>({ start: false, end: false });
  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const update = () => {
      const start = strip.scrollLeft > 1;
      const end = strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    update();
    strip.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    return () => {
      strip.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [content]);
  return { ref, edges };
}

function DockButton({ tab, onDock }: { tab: DockableTabId; onDock: (e: ReactMouseEvent<HTMLElement>) => void }) {
  return (
    <button
      type="button"
      className="ph-btn"
      onClick={onDock}
      onDoubleClick={(e) => e.stopPropagation()}
      title="Move or close"
      aria-label={`Move ${toolTabTitle(tab)} to another panel`}
      aria-haspopup="menu"
    >
      <PanelsTopLeft size={14} aria-hidden="true" />
    </button>
  );
}

function scrollStripSideways(e: ReactWheelEvent<HTMLDivElement>): void {
  if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.currentTarget.scrollLeft += e.deltaY;
}

export function rightTabId(idBase: string, tab: DockableTabId): string {
  return `${idBase}-tab-${tab}`;
}

export function PaneTabsHeader({
  sessionId,
  tabs,
  top,
  idBase,
  panelId,
  onDock,
  onTabContextMenu
}: {
  sessionId: string;
  tabs: DockableTabId[];
  top: DockableTabId;
  idBase: string;
  panelId: string;
  onDock: (e: ReactMouseEvent<HTMLElement>) => void;
  onTabContextMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => void;
}) {
  const setActive = usePanelStore((s) => s.setActive);
  const moveTab = usePanelStore((s) => s.moveTab);
  const summary = usePaneSummary(top, sessionId);
  const strip = useScrollEdges(tabs.join(","));

  return (
    <div className="phead" onDoubleClick={() => window.cw.toggleMaximizeWindow()}>
      <div
        ref={strip.ref}
        className={`ph-tabs${strip.edges.start ? " fade-start" : ""}${strip.edges.end ? " fade-end" : ""}`}
        role="tablist"
        aria-label="Right panel tools"
        onKeyDown={focusSiblingTab}
        onWheel={scrollStripSideways}
      >
        {tabs.map((id) => (
          <DockTab
            key={id}
            tab={id}
            sessionId={sessionId}
            active={id === top}
            id={rightTabId(idBase, id)}
            controls={panelId}
            onActivate={() => setActive(sessionId, "right", id)}
            onContextMenu={onTabContextMenu(id)}
            onClose={() => moveTab(sessionId, id, "closed")}
          />
        ))}
      </div>
      {summary && <span className="ph-m">{summary}</span>}
      <span className="ph-a">
        <DockButton tab={top} onDock={onDock} />
      </span>
    </div>
  );
}
