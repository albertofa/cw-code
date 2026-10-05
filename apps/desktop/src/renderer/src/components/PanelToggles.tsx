import { PanelBottom, PanelRight } from "lucide-react";
import type { DockableTabId } from "@cw-code/contracts";
import { isBottomOpen } from "../stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";

export function PanelToggles({
  sessionId,
  isToolAvailable
}: {
  sessionId: string | undefined;
  isToolAvailable: (tab: DockableTabId) => boolean;
}) {
  const { rightVisible, dockByTab, bottomCollapsed } = usePanelStore((s) => selectSessionPanel(s, sessionId));
  const setRightVisible = usePanelStore((s) => s.setRightVisible);
  const setBottomCollapsed = usePanelStore((s) => s.setBottomCollapsed);
  const activateOrOpenTab = usePanelStore((s) => s.activateOrOpen);

  const hasBottomTools = isBottomOpen(dockByTab, isToolAvailable);
  const bottomOpen = hasBottomTools && !bottomCollapsed;
  const bottomLabel = bottomOpen ? "Hide bottom panel" : "Show bottom panel";
  const rightLabel = rightVisible ? "Hide tool panel" : "Show tool panel";

  return (
    <div className="rail-end">
      <button
        className={`rail-b${bottomOpen ? " on-soft" : ""}`}
        onClick={() => {
          if (!hasBottomTools) {
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
