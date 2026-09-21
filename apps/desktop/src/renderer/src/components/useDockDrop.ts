import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import type { DockableTabId, PanelId } from "@cw-code/contracts";
import { TAB_DRAG_MIME, resolveDrop } from "./dockable.js";
import { isDockableTabId } from "../stores/panelLayout.js";
import { usePanelStore } from "../stores/panelStore.js";

export interface DockDropBinding {
  onDragEnter: (e: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: ReactDragEvent<HTMLElement>) => void;
}

export function startTabDrag(e: ReactDragEvent<HTMLElement>, tabId: DockableTabId): void {
  e.dataTransfer.setData(TAB_DRAG_MIME, tabId);
  usePanelStore.getState().setDraggingTab(isDockableTabId(tabId) ? tabId : null);
  try {
    e.dataTransfer.effectAllowed = "move";
  } catch {
  }
  e.currentTarget.classList.add("tab-dragging");
}

export function endTabDrag(e: ReactDragEvent<HTMLElement>): void {
  e.currentTarget.classList.remove("tab-dragging");
  usePanelStore.getState().setDraggingTab(null);
}

export function useDockDrop(panel: PanelId): { over: boolean; bind: DockDropBinding } {
  const [over, setOver] = useState(false);
  const depthRef = useRef(0);
  const moveTab = usePanelStore((s) => s.moveTab);
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
        moveTab(drop.tab, drop.panel);
        usePanelStore.getState().setDraggingTab(null);
      }
    }
  };
}