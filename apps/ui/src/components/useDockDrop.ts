import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import type { DockableTabId, PanelId } from "@cw-code/contracts";
import { TAB_DRAG_SESSION_MIME, TAB_DRAG_MIME, resolveDrop } from "./dockable.js";
import { isDockableTabId } from "../stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";

const RIGHT_OVERLAY_QUERY = "(max-width: 900px)";
const OVERLAY_DRAG_CLASS = "right-overlay-dragging";

export interface DockDropBinding {
  onDragEnter: (e: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: ReactDragEvent<HTMLElement>) => void;
}

export interface DockDropOptions {
  onDrop?: (tab: DockableTabId) => void;
  ignoreRailDrags?: boolean;
}

export interface TabDragOptions {
  fromRail?: boolean;
}

function hideRightOverlayDuringDrag(sessionId: string): void {
  if (!window.matchMedia?.(RIGHT_OVERLAY_QUERY).matches) return;
  if (!selectSessionPanel(usePanelStore.getState(), sessionId).rightVisible) return;
  requestAnimationFrame(() => {
    if (usePanelStore.getState().draggingTab !== null) document.body.classList.add(OVERLAY_DRAG_CLASS);
  });
}

function finishTabDrag(): void {
  document.body.classList.remove(OVERLAY_DRAG_CLASS);
  usePanelStore.getState().setDraggingTab(null);
}

export function startTabDrag(
  e: ReactDragEvent<HTMLElement>,
  tabId: DockableTabId,
  sessionId: string | undefined,
  { fromRail = false }: TabDragOptions = {}
): void {
  if (!sessionId) return;
  e.dataTransfer.setData(TAB_DRAG_MIME, tabId);
  e.dataTransfer.setData(TAB_DRAG_SESSION_MIME, sessionId);
  usePanelStore.getState().setDraggingTab(isDockableTabId(tabId) ? tabId : null, fromRail);
  try {
    e.dataTransfer.effectAllowed = "move";
  } catch {
  }
  e.currentTarget.classList.add("tab-dragging");
  hideRightOverlayDuringDrag(sessionId);
}

export function endTabDrag(e: ReactDragEvent<HTMLElement>): void {
  e.currentTarget.classList.remove("tab-dragging");
  finishTabDrag();
}

export function useDockDrop(
  panel: PanelId,
  sessionId: string | undefined,
  options: DockDropOptions = {}
): { over: boolean; bind: DockDropBinding } {
  const [over, setOver] = useState(false);
  const depthRef = useRef(0);
  const moveTab = usePanelStore((s) => s.moveTab);
  const setRightVisible = usePanelStore((s) => s.setRightVisible);
  const dragging = usePanelStore((s) => s.draggingTab !== null);
  useEffect(() => {
    const reset = () => {
      depthRef.current = 0;
      setOver(false);
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, []);
  useEffect(() => {
    if (dragging) return;
    depthRef.current = 0;
    setOver(false);
  }, [dragging]);
  const ignored = () => options.ignoreRailDrags === true && usePanelStore.getState().dragFromRail;
  return {
    over,
    bind: {
      onDragEnter: (e) => {
        if (ignored()) return;
        e.preventDefault();
        depthRef.current += 1;
        setOver(true);
      },
      onDragOver: (e) => {
        if (ignored()) return;
        e.preventDefault();
        try {
          e.dataTransfer.dropEffect = "move";
        } catch {
        }
      },
      onDragLeave: () => {
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) setOver(false);
      },
      onDrop: (e) => {
        depthRef.current = 0;
        if (ignored()) return;
        const drop = resolveDrop(e.dataTransfer.getData(TAB_DRAG_MIME), panel);
        if (!drop) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const sourceSessionId = e.dataTransfer.getData(TAB_DRAG_SESSION_MIME);
        if (sourceSessionId === sessionId && sessionId) {
          if (panel !== "right" && document.body.classList.contains(OVERLAY_DRAG_CLASS)) setRightVisible(sessionId, false);
          if (options.onDrop) options.onDrop(drop.tab);
          else moveTab(sessionId, drop.tab, drop.panel);
        }
        finishTabDrag();
      }
    }
  };
}
