import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import type { DockableTabId, PanelId } from "@cw-code/contracts";
import { TAB_DRAG_SESSION_MIME, TAB_DRAG_MIME, resolveDrop } from "./dockable.js";
import { isDockableTabId } from "../stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";

const RIGHT_OVERLAY_QUERY = "(max-width: 900px)";

export interface DockDropBinding {
  onDragEnter: (e: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: ReactDragEvent<HTMLElement>) => void;
}

export interface DockDropOptions {
  onDrop?: (tab: DockableTabId) => void;
}

function closeRightOverlay(sessionId: string): void {
  if (!window.matchMedia?.(RIGHT_OVERLAY_QUERY).matches) return;
  if (!selectSessionPanel(usePanelStore.getState(), sessionId).rightVisible) return;
  requestAnimationFrame(() => usePanelStore.getState().setRightVisible(sessionId, false));
  const onPointerMove = (e: PointerEvent) => {
    if (e.buttons !== 0) return;
    window.removeEventListener("pointermove", onPointerMove);
    if (usePanelStore.getState().draggingTab !== null) usePanelStore.getState().setDraggingTab(null);
  };
  window.addEventListener("pointermove", onPointerMove);
}

export function startTabDrag(
  e: ReactDragEvent<HTMLElement>,
  tabId: DockableTabId,
  sessionId: string | undefined
): void {
  if (!sessionId) return;
  e.dataTransfer.setData(TAB_DRAG_MIME, tabId);
  e.dataTransfer.setData(TAB_DRAG_SESSION_MIME, sessionId);
  usePanelStore.getState().setDraggingTab(isDockableTabId(tabId) ? tabId : null);
  try {
    e.dataTransfer.effectAllowed = "move";
  } catch {
  }
  e.currentTarget.classList.add("tab-dragging");
  closeRightOverlay(sessionId);
}

export function endTabDrag(e: ReactDragEvent<HTMLElement>): void {
  e.currentTarget.classList.remove("tab-dragging");
  usePanelStore.getState().setDraggingTab(null);
}

export function useDockDrop(
  panel: PanelId,
  sessionId: string | undefined,
  options: DockDropOptions = {}
): { over: boolean; bind: DockDropBinding } {
  const [over, setOver] = useState(false);
  const depthRef = useRef(0);
  const moveTab = usePanelStore((s) => s.moveTab);
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
  return {
    over,
    bind: {
      onDragEnter: (e) => {
        e.preventDefault();
        depthRef.current += 1;
        setOver(true);
      },
      onDragOver: (e) => {
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
        const drop = resolveDrop(e.dataTransfer.getData(TAB_DRAG_MIME), panel);
        if (!drop) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const sourceSessionId = e.dataTransfer.getData(TAB_DRAG_SESSION_MIME);
        if (sourceSessionId === sessionId && sessionId) {
          if (options.onDrop) options.onDrop(drop.tab);
          else moveTab(sessionId, drop.tab, drop.panel);
        }
        usePanelStore.getState().setDraggingTab(null);
      }
    }
  };
}
