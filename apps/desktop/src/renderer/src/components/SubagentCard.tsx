import { useEffect } from "react";
import { Bot } from "lucide-react";
import type { SubagentGroup } from "./subagents.js";
import { formatSubagentCount, formatTokensShort, groupStatus, groupSubagentMetrics } from "./subagents.js";
import { openAgentsPanel } from "./AgentsPanel.js";

export function subagentAnchorId(groupId: string): string {
  return `subagent-group-${groupId}`;
}

export function SubagentCard({ group }: { group: SubagentGroup }) {
  const status = groupStatus(group.items);
  const metrics = groupSubagentMetrics(group.items);

  useEffect(() => {
    const onShow = (e: Event) => {
      const detail = (e as CustomEvent<{ groupId?: string }>).detail;
      if (detail?.groupId !== group.id) return;
      const el = document.getElementById(subagentAnchorId(group.id));
      if (!el) return;
      el.classList.add("flash");
      window.setTimeout(() => el.classList.remove("flash"), 1600);
    };
    window.addEventListener("cw:show-subagent", onShow as EventListener);
    return () => window.removeEventListener("cw:show-subagent", onShow as EventListener);
  }, [group.id]);

  return (
    <div
      id={subagentAnchorId(group.id)}
      className={`suba-card${status === "running" ? " running" : ""}${status === "error" ? " error" : ""}`}
    >
      <div
        className="suba-head"
        onClick={() => openAgentsPanel(group.id)}
        title="Open subagents panel"
      >
        <span className={`suba-dot ${status}`} />
        <Bot size={13} className="tool-icon" />
        <span className="tool-action">
          {status === "running" ? "Running" : "Ran"} {formatSubagentCount(group.items.length)}
        </span>
        <span className="suba-status">
          {status === "completed" ? "✓ completed" : status === "running" ? "● running" : "⚠ error"}
        </span>
        {metrics.effort && <span className="suba-metric">{metrics.effort} effort</span>}
        {metrics.tools !== undefined && <span className="suba-metric">{metrics.tools} tools</span>}
        {metrics.tokens !== undefined && (
          <span className="suba-metric">Σ {formatTokensShort(metrics.tokens).toUpperCase()} tok</span>
        )}
        <span className="suba-view">View</span>
        <span className="tool-caret">▸</span>
      </div>
    </div>
  );
}
