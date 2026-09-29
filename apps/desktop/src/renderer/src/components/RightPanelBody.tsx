import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { DockableTabId } from "@cw-code/contracts";
import { SPLIT_RATIO_DEFAULT, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN, clampSplitRatio } from "../stores/panelLayout.js";
import { usePanelStore } from "../stores/panelStore.js";
import { PaneHeader } from "./PaneHeader.js";
import { ToolContent } from "./ToolContent.js";
import "./toolRail.css";

const SPLIT_RATIO_KEY_STEP = 0.02;

const toPercent = (value: number): number => Math.round(value * 100);

export function RightPanelBody({
  sessionId,
  top,
  split,
  ratio,
  onToolMenu
}: {
  sessionId: string;
  top: DockableTabId;
  split: DockableTabId | null;
  ratio: number;
  onToolMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => void;
}) {
  const setRightSplit = usePanelStore((s) => s.setRightSplit);
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

  const panes = [
    <div className="right-pane" key={top} style={split ? { flex: `${shownRatio} 1 0` } : undefined}>
      <PaneHeader tab={top} sessionId={sessionId} onDock={onToolMenu(top)} />
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
        <PaneHeader tab={split} sessionId={sessionId} split onDock={onToolMenu(split)} onClose={() => setRightSplit(sessionId, null)} />
        <div className="right-pane-body">
          <ToolContent tab={split} sessionId={sessionId} panel="right" />
        </div>
      </div>
    );
  }

  return (
    <div className="right-body" ref={bodyRef}>
      {panes}
    </div>
  );
}
