import { Fragment, type MouseEvent as ReactMouseEvent } from "react";
import type { DockableTabId } from "@cw-code/contracts";
import type { DriverName } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { PanelToggles } from "./PanelToggles.js";
import { endTabDrag, startTabDrag } from "./useDockDrop.js";
import { useLinkedPrs } from "./useLinkedPr.js";
import { TOOL_TABS, isHarnessTabId } from "./toolTabs.js";
import { checkCountsTone, checksTone, railGroups, type RailDotTone } from "./railTools.js";
import "./toolRail.css";

export interface SubagentStats {
  total: number;
  running: number;
}

function PrDot({ sessionId }: { sessionId: string }) {
  const { items } = useLinkedPrs(sessionId);
  const fallback = useAppStore((s) => s.gitStatusBySession[sessionId]?.pullRequest?.checks);
  const linked = checksTone(items.flatMap((item) => (item.summary ?? item.detail)?.ci ?? []));
  const tone: RailDotTone | null = linked ?? checkCountsTone(fallback);
  if (tone === null) return null;
  return <span className={`rail-dot ${tone}`} aria-hidden="true" />;
}

function DiffBadge({ sessionId }: { sessionId: string }) {
  const dirtyCount = useAppStore((s) => s.gitStatusBySession[sessionId]?.dirtyCount ?? 0);
  if (dirtyCount === 0) return null;
  return <span className="rail-badge" aria-hidden="true">{dirtyCount > 99 ? "99+" : dirtyCount}</span>;
}

function subagentTitle(stats: SubagentStats): string {
  const noun = `${stats.total} subagent${stats.total === 1 ? "" : "s"}`;
  return stats.running > 0 ? `${noun} (${stats.running} running)` : noun;
}

export function ToolRail({
  sessionId,
  driver,
  hasPr,
  hasPreview,
  subagents,
  rightActive,
  rightSplit,
  isToolAvailable,
  onToolContextMenu
}: {
  sessionId: string | undefined;
  driver: DriverName | undefined;
  hasPr: boolean;
  hasPreview: boolean;
  subagents: SubagentStats;
  rightActive: DockableTabId | null;
  rightSplit: DockableTabId | null;
  isToolAvailable: (tab: DockableTabId) => boolean;
  onToolContextMenu: (tab: DockableTabId) => (e: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { dockByTab, rightVisible } = usePanelStore((s) => selectSessionPanel(s, sessionId));
  const autoLocation = usePanelStore((s) => s.autoLocation);
  const revealTab = usePanelStore((s) => s.revealTab);
  const groups = railGroups(driver, hasPr, hasPreview);

  return (
    <nav className="rail" aria-label="Tools">
      <div className="rail-drag" onDoubleClick={() => window.cw.toggleMaximizeWindow()} />
      {groups.map((group, index) => (
        <Fragment key={group.join("+")}>
          {index > 0 && <span className="rail-sep" aria-hidden="true" />}
          {group.map((id) => {
            const def = TOOL_TABS.find((tab) => tab.id === id);
            if (!def) return null;
            const docked = dockByTab[id];
            const away = docked === "main" || docked === "bottom";
            const active = rightVisible && docked === "right" && (id === rightActive || id === rightSplit);
            const showAgents = id === "agents" && subagents.total > 0;
            const place = docked === "closed" ? `opens in ${autoLocation[id] ?? "right"}` : `open in ${docked}`;
            const detail = showAgents ? ` · ${subagentTitle(subagents)}` : "";
            const label = `${def.title}${detail} · ${place}`;
            return (
              <button
                key={id}
                className={`rail-b${active ? " on" : ""}${away ? " away" : ""}`}
                disabled={!sessionId}
                onClick={() => sessionId && revealTab(sessionId, id)}
                onContextMenu={onToolContextMenu(id)}
                draggable={sessionId !== undefined}
                onDragStart={(e) => startTabDrag(e, id, sessionId)}
                onDragEnd={endTabDrag}
                data-tool={id}
                title={label}
                aria-label={label}
                aria-pressed={active}
              >
                {isHarnessTabId(id) ? <DriverIcon driver={id} size={16} /> : <def.Icon size={16} aria-hidden="true" />}
                {id === "diff" && sessionId && <DiffBadge sessionId={sessionId} />}
                {id === "pr" && sessionId && <PrDot sessionId={sessionId} />}
                {showAgents && (
                  <span className={`rail-badge${subagents.running > 0 ? " run" : ""}`} aria-hidden="true">
                    {subagents.total > 99 ? "99+" : subagents.total}
                  </span>
                )}
              </button>
            );
          })}
        </Fragment>
      ))}
      <PanelToggles sessionId={sessionId} splitActive={rightVisible && rightSplit !== null} isToolAvailable={isToolAvailable} />
    </nav>
  );
}
