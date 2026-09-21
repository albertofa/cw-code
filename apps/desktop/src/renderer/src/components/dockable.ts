import type { DockableTabId, PanelId } from "@cw-code/contracts";
import { isDockableTabId } from "../stores/panelLayout.js";

export const TAB_DRAG_MIME = "application/x-cw-tab";

export interface DockDrop {
  tab: DockableTabId;
  panel: PanelId;
}

export function resolveDrop(draggedId: string, panel: PanelId): DockDrop | null {
  if (draggedId === "chat") return null;
  if (!isDockableTabId(draggedId)) return null;
  return { tab: draggedId, panel };
}