import { PanelBottomClose, PanelBottomOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { isBottomOpen, tabsInPanel } from "../stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";

export function PanelToggles({ sessionId }: { sessionId: string | undefined }) {
  const { rightVisible, dockByTab, bottomCollapsed } = usePanelStore((s) => selectSessionPanel(s, sessionId));
  const setRightVisible = usePanelStore((s) => s.setRightVisible);
  const setBottomCollapsed = usePanelStore((s) => s.setBottomCollapsed);
  const activateOrOpenTab = usePanelStore((s) => s.activateOrOpen);

  const bottomOpen = isBottomOpen(dockByTab) && !bottomCollapsed;

  return (
    <div className="panel-toggles">
      <button
        className="panel-toggle"
        onClick={() => setRightVisible(sessionId, !rightVisible)}
        title={rightVisible ? "Hide right panel" : "Show right panel"}
        aria-label={rightVisible ? "Hide right panel" : "Show right panel"}
        aria-expanded={rightVisible}
      >
        {rightVisible ? <PanelRightClose size={15} aria-hidden="true" /> : <PanelRightOpen size={15} aria-hidden="true" />}
      </button>
      <button
        className="panel-toggle"
        onClick={() => {
          if (tabsInPanel(dockByTab, "bottom").length === 0) {
            activateOrOpenTab(sessionId, "shell");
            setBottomCollapsed(sessionId, false);
          } else {
            setBottomCollapsed(sessionId, !bottomCollapsed);
          }
        }}
        title={bottomOpen ? "Hide bottom panel" : "Show bottom panel"}
        aria-label={bottomOpen ? "Hide bottom panel" : "Show bottom panel"}
        aria-expanded={bottomOpen}
      >
        {bottomOpen ? <PanelBottomClose size={15} aria-hidden="true" /> : <PanelBottomOpen size={15} aria-hidden="true" />}
      </button>
    </div>
  );
}
