import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Rows2 } from "lucide-react";
import type { DockableTabId } from "@cw-code/contracts";
import {
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  clampSplitRatio,
  resolveSplitDrop
} from "../stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";
import { PaneHeader, PaneTabsHeader } from "./PaneHeader.js";
import { ToolContent } from "./ToolContent.js";
import { useDockDrop } from "./useDockDrop.js";
import "./toolRail.css";

const SPLIT_RATIO_KEY_STEP = 0.02;

const toPercent = (value: number): number => Math.round(value * 100);

function SplitDropZone({ sessionId, onDropTab }: { sessionId: string; onDropTab: (tab: DockableTabId) => void }) {
  const drop = useDockDrop("right", sessionId, { onDrop: onDropTab });
  return (
    <div className={`split-drop${drop.over ? " over" : ""}`} {...drop.bind}>
      <span className="split-drop-label">
        <Rows2 size={14} aria-hidden="true" />
        Open in split
      </span>
    </div>
  );
}

export function RightPanelBody({
  sessionId,
  tabs,
  top,
  split,
  ratio,
  isToolAvailable,
  onToolMenu,
  onToolContextMenu
}: {
  sessionId: string;
  tabs: DockableTabId[];
  top: DockableTabId;
  split: DockableTabId | null;
  ratio: number;
  isToolAvailable: (tab: DockableTabId) => boolean;
  onToolMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => void;
  onToolContextMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => void;
}) {
  const setRightSplit = usePanelStore((s) => s.setRightSplit);
  const placeRightSplit = usePanelStore((s) => s.placeRightSplit);
  const draggingTab = usePanelStore((s) => s.draggingTab);
  const dockByTab = usePanelStore((s) => selectSessionPanel(s, sessionId).dockByTab);
  const setRightSplitRatio = usePanelStore((s) => s.setRightSplitRatio);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const abortDragRef = useRef<(() => void) | null>(null);
  const shownRatio = dragRatio ?? ratio;

  useEffect(() => () => abortDragRef.current?.(), []);

  const endDrag = (onMove: (ev: MouseEvent) => void, onUp: () => void) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    abortDragRef.current = null;
  };

  const onDividerDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (!body) return;
    e.preventDefault();
    let latest = ratio;
    const onMove = (ev: MouseEvent) => {
      const rect = body.getBoundingClientRect();
      latest = clampSplitRatio((ev.clientY - rect.top) / rect.height);
      setDragRatio(latest);
    };
    const onUp = () => {
      endDrag(onMove, onUp);
      setDragRatio(null);
      setRightSplitRatio(sessionId, latest);
    };
    abortDragRef.current = () => endDrag(onMove, onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onDividerKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowUp" ? -SPLIT_RATIO_KEY_STEP : e.key === "ArrowDown" ? SPLIT_RATIO_KEY_STEP : 0;
    if (delta !== 0) {
      e.preventDefault();
      setRightSplitRatio(sessionId, ratio + delta);
    } else if (e.key === "Home" || e.key === "End" || e.key === "Enter") {
      e.preventDefault();
      setRightSplitRatio(sessionId, SPLIT_RATIO_DEFAULT);
    }
  };

  const splitDropOpen = draggingTab !== null && resolveSplitDrop(dockByTab, top, split, draggingTab, isToolAvailable).ok;
  const onSplitDrop = (tab: DockableTabId) => {
    const drop = resolveSplitDrop(dockByTab, top, split, tab, isToolAvailable);
    if (drop.ok) placeRightSplit(sessionId, drop);
    else console.warn(`[panels] split drop of ${tab} rejected: ${drop.reason}`);
  };
  const splitDropZone = splitDropOpen ? <SplitDropZone sessionId={sessionId} onDropTab={onSplitDrop} /> : null;

  const panes = [
    <div className="right-pane" key={top} style={split ? { flex: `${shownRatio} 1 0` } : undefined}>
      <PaneTabsHeader
        sessionId={sessionId}
        tabs={tabs}
        top={top}
        split={split}
        onDock={onToolMenu(top)}
        onTabContextMenu={onToolContextMenu}
      />
      <div className="right-pane-body">
        <ToolContent tab={top} sessionId={sessionId} panel="right" />
      </div>
    </div>
  ];
  if (split) {
    panes.push(
      <div
        className="right-split-divider"
        key="divider"
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label="Resize split"
        aria-valuenow={toPercent(shownRatio)}
        aria-valuemin={toPercent(SPLIT_RATIO_MIN)}
        aria-valuemax={toPercent(SPLIT_RATIO_MAX)}
        onKeyDown={onDividerKey}
        onMouseDown={onDividerDown}
        onDoubleClick={() => setRightSplitRatio(sessionId, SPLIT_RATIO_DEFAULT)}
        title="Drag or use arrow keys to resize · double-click or Enter to reset"
      />,
      <div className="right-pane" key={split} style={{ flex: `${1 - shownRatio} 1 0` }}>
        <PaneHeader tab={split} sessionId={sessionId} onDock={onToolMenu(split)} onClose={() => setRightSplit(sessionId, null)} />
        <div className="right-pane-body">
          <ToolContent tab={split} sessionId={sessionId} panel="right" />
        </div>
        {splitDropZone}
      </div>
    );
  }

  return (
    <div className="right-body" ref={bodyRef}>
      {panes}
      {split === null && splitDropZone}
    </div>
  );
}
