import { PanelBottom, PanelRight, Rows2 } from "lucide-react";
import type { DockableTabId } from "@cw-code/contracts";
import { isBottomOpen, tabsInPanel } from "../stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";

export function PanelToggles({
  sessionId,
  splitActive,
  isToolAvailable,
  rightTop
}: {
  sessionId: string | undefined;
  splitActive: boolean;
  isToolAvailable: (tab: DockableTabId) => boolean;
  rightTop: DockableTabId | null;
}) {
  const { rightVisible, dockByTab, bottomCollapsed } = usePanelStore((s) => selectSessionPanel(s, sessionId));
  const setRightVisible = usePanelStore((s) => s.setRightVisible);
  const setBottomCollapsed = usePanelStore((s) => s.setBottomCollapsed);
  const activateOrOpenTab = usePanelStore((s) => s.activateOrOpen);
  const toggleRightSplit = usePanelStore((s) => s.toggleRightSplit);

  const bottomOpen = isBottomOpen(dockByTab) && !bottomCollapsed;
  const splitLabel = splitActive ? "Close the split" : "Split the tool panel";
  const bottomLabel = bottomOpen ? "Hide bottom panel" : "Show bottom panel";
  const rightLabel = rightVisible ? "Hide tool panel" : "Show tool panel";

  return (
    <div className="rail-end">
      <button
        className={`rail-b${splitActive ? " on-soft" : ""}`}
        onClick={() => toggleRightSplit(sessionId, isToolAvailable, rightTop)}
        disabled={!sessionId}
        title={splitLabel}
        aria-label={splitLabel}
        aria-pressed={splitActive}
      >
        <Rows2 size={16} aria-hidden="true" />
      </button>
      <button
        className={`rail-b${bottomOpen ? " on-soft" : ""}`}
        onClick={() => {
          if (tabsInPanel(dockByTab, "bottom").length === 0) {
            activateOrOpenTab(sessionId, "shell");
            setBottomCollapsed(sessionId, false);
          } else {
            setBottomCollapsed(sessionId, !bottomCollapsed);
          }
        }}
        disabled={!sessionId}
        title={bottomLabel}
        aria-label={bottomLabel}
        aria-expanded={bottomOpen}
      >
        <PanelBottom size={16} aria-hidden="true" />
      </button>
      <button
        className={`rail-b${rightVisible ? " on-soft" : ""}`}
        onClick={() => setRightVisible(sessionId, !rightVisible)}
        disabled={!sessionId}
        title={rightLabel}
        aria-label={rightLabel}
        aria-expanded={rightVisible}
      >
        <PanelRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
