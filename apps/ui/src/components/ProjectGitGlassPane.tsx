import { X } from "lucide-react";
import { usePanelStore } from "../stores/panelStore.js";
import { GitGlassPanel } from "./history/GitGlassPanel.js";
import "./toolRail.css";

export function ProjectGitGlassPane({ projectId }: { projectId: string }) {
  const setPendingGlassOpen = usePanelStore((s) => s.setPendingGlassOpen);
  return (
    <div className="right-body">
      <div className="phead" onDoubleClick={() => window.cw.shell?.toggleMaximizeWindow()}>
        <span className="ph-m">Git glass</span>
        <span className="ph-a">
          <button type="button" className="ph-btn" onClick={() => setPendingGlassOpen(false)} title="Close" aria-label="Close Git glass">
            <X size={14} aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="right-pane-body">
        <GitGlassPanel key={projectId} scope={{ projectId }} />
      </div>
    </div>
  );
}
