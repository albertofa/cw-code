import { PanelBottomClose, PanelBottomOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { isBottomOpen, tabsInPanel } from "../stores/panelLayout.js";
import { usePanelStore } from "../stores/panelStore.js";

export function PanelToggles() {
  const rightVisible = usePanelStore((s) => s.rightVisible);
  const setRightVisible = usePanelStore((s) => s.setRightVisible);
  const dockByTab = usePanelStore((s) => s.dockByTab);
  const bottomCollapsed = usePanelStore((s) => s.bottomCollapsed);
  const setBottomCollapsed = usePanelStore((s) => s.setBottomCollapsed);
  const activateOrOpenTab = usePanelStore((s) => s.activateOrOpen);

  const bottomOpen = isBottomOpen(dockByTab) && !bottomCollapsed;

  return (
    <div className="panel-toggles">
      <button
        className="panel-toggle"
        onClick={() => setRightVisible(!rightVisible)}
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
            activateOrOpenTab("shell");
            setBottomCollapsed(false);
          } else {
            setBottomCollapsed(!bottomCollapsed);
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
