import type { MouseEvent as ReactMouseEvent } from "react";
import { PanelsTopLeft, X } from "lucide-react";
import type { DockableTabId } from "@cw-code/contracts";
import { useAppStore } from "../stores/appStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { TOOL_TABS, isHarnessTabId } from "./toolTabs.js";
import { gitDiffSummary } from "./railTools.js";
import "./toolRail.css";

export function PaneHeader({
  tab,
  sessionId,
  split = false,
  onDock,
  onClose
}: {
  tab: DockableTabId;
  sessionId: string | undefined;
  split?: boolean;
  onDock: (e: ReactMouseEvent<HTMLElement>) => void;
  onClose?: () => void;
}) {
  const gitStatus = useAppStore((s) => (sessionId ? s.gitStatusBySession[sessionId] : undefined));
  const def = TOOL_TABS.find((item) => item.id === tab);
  if (!def) return null;
  const summary = tab === "diff" ? gitDiffSummary(gitStatus) : undefined;

  return (
    <div className={`phead${split ? " sub" : ""}`} onDoubleClick={split ? undefined : () => window.cw.toggleMaximizeWindow()}>
      {isHarnessTabId(tab) ? <DriverIcon driver={tab} size={16} /> : <def.Icon size={16} className="ph-ic" aria-hidden="true" />}
      <span className="ph-t">{def.title}</span>
      {summary && <span className="ph-m">{summary}</span>}
      <span className="ph-a">
        <button
          type="button"
          className="ph-btn"
          onClick={onDock}
          onDoubleClick={(e) => e.stopPropagation()}
          title="Open in main or bottom panel"
          aria-label={`Move ${def.title} to another panel`}
          aria-haspopup="menu"
        >
          <PanelsTopLeft size={14} aria-hidden="true" />
        </button>
        {onClose && (
          <button type="button" className="ph-btn" onClick={onClose} title="Close split" aria-label="Close split">
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </span>
    </div>
  );
}
