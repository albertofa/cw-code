import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import { PanelsTopLeft, X } from "lucide-react";
import type { DockableTabId } from "@cw-code/contracts";
import { useAppStore } from "../stores/appStore.js";
import { usePanelStore } from "../stores/panelStore.js";
import { DockTab } from "./DockTab.js";
import { DriverIcon } from "./DriverIcon.js";
import { TOOL_TABS, isHarnessTabId, toolTabTitle } from "./toolTabs.js";
import { paneDiffSummary } from "./railTools.js";
import { endTabDrag, startTabDrag } from "./useDockDrop.js";
import "./toolRail.css";

const TAB_NAV_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];

function usePaneSummary(tab: DockableTabId, sessionId: string | undefined): string | undefined {
  const gitStatus = useAppStore((s) => (sessionId && tab === "diff" ? s.gitStatusBySession[sessionId] : undefined));
  const turnDiffSummary = usePanelStore((s) => (sessionId && tab === "diff" ? s.turnDiffSummaryBySession[sessionId] : undefined));
  return tab === "diff" ? paneDiffSummary(gitStatus, turnDiffSummary) : undefined;
}

function DockButton({ tab, onDock }: { tab: DockableTabId; onDock: (e: ReactMouseEvent<HTMLElement>) => void }) {
  return (
    <button
      type="button"
      className="ph-btn"
      onClick={onDock}
      onDoubleClick={(e) => e.stopPropagation()}
      title="Move, split or close"
      aria-label={`Move ${toolTabTitle(tab)} to another panel`}
      aria-haspopup="menu"
    >
      <PanelsTopLeft size={14} aria-hidden="true" />
    </button>
  );
}

function focusSiblingTab(e: ReactKeyboardEvent<HTMLDivElement>): void {
  if (!TAB_NAV_KEYS.includes(e.key)) return;
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  if (tabs.length === 0) return;
  const current = tabs.findIndex((tab) => tab === document.activeElement);
  const last = tabs.length - 1;
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? last : e.key === "ArrowLeft" ? (current <= 0 ? last : current - 1) : current >= last ? 0 : current + 1;
  e.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function scrollStripSideways(e: ReactWheelEvent<HTMLDivElement>): void {
  if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.currentTarget.scrollLeft += e.deltaY;
}

export function PaneTabsHeader({
  sessionId,
  tabs,
  top,
  split,
  onDock,
  onTabContextMenu
}: {
  sessionId: string;
  tabs: DockableTabId[];
  top: DockableTabId;
  split: DockableTabId | null;
  onDock: (e: ReactMouseEvent<HTMLElement>) => void;
  onTabContextMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => void;
}) {
  const setActive = usePanelStore((s) => s.setActive);
  const moveTab = usePanelStore((s) => s.moveTab);
  const summary = usePaneSummary(top, sessionId);

  return (
    <div className="phead" onDoubleClick={() => window.cw.toggleMaximizeWindow()}>
      <div className="ph-tabs" role="tablist" aria-label="Right panel tools" onKeyDown={focusSiblingTab} onWheel={scrollStripSideways}>
        {tabs.map((id) => (
          <DockTab
            key={id}
            tab={id}
            sessionId={sessionId}
            active={id === top}
            marker={id === split ? "split" : undefined}
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

export function PaneHeader({
  tab,
  sessionId,
  onDock,
  onClose
}: {
  tab: DockableTabId;
  sessionId: string;
  onDock: (e: ReactMouseEvent<HTMLElement>) => void;
  onClose: () => void;
}) {
  const summary = usePaneSummary(tab, sessionId);
  const def = TOOL_TABS.find((item) => item.id === tab);
  if (!def) return null;

  return (
    <div className="phead sub">
      <span
        className="ph-grab"
        draggable
        onDragStart={(e) => startTabDrag(e, tab, sessionId)}
        onDragEnd={endTabDrag}
        title={`${def.title} - drag to move`}
      >
        {isHarnessTabId(tab) ? <DriverIcon driver={tab} size={16} /> : <def.Icon size={16} className="ph-ic" aria-hidden="true" />}
        <span className="ph-t">{def.title}</span>
      </span>
      {summary && <span className="ph-m">{summary}</span>}
      <span className="ph-a">
        <DockButton tab={tab} onDock={onDock} />
        <button type="button" className="ph-btn" onClick={onClose} title="Close split" aria-label="Close split">
          <X size={14} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
