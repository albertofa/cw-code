import { memo, useEffect, useId, useState } from "react";
import { Bot, ChevronRight, PanelRight } from "lucide-react";
import type { SubagentToolActivity } from "../cw.js";
import type { SubagentGroup, SubagentInfo } from "./subagents.js";
import { formatTokensShort, subagentActivity } from "./subagents.js";
import { openAgentsPanel, useSessionWorkspace } from "./AgentsPanel.js";
import { ToolCard, ToolRow, type ToolStatus } from "./ToolCard.js";
import { formatDuration, formatToolDuration } from "./toolSummaries.js";
import { useElapsed } from "./useElapsed.js";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";

const EMPTY_MESSAGES: ChatMessage[] = [];
const FLASH_MS = 1600;
const EXCERPT_MAX = 600;

export function subagentAnchorId(groupId: string): string {
  return `subagent-group-${groupId}`;
}

function subagentRowId(itemId: string): string {
  return `subagent-row-${itemId}`;
}

export function subagentToolMessage(t: SubagentToolActivity, turnId: string): ChatMessage {
  const done = t.output !== undefined;
  return {
    id: t.id,
    role: "tool",
    text: `${t.name} ${JSON.stringify(t.input ?? null)?.slice(0, 300) ?? ""}`,
    turnId,
    toolName: t.name,
    toolInput: t.input,
    ...(done ? { toolOutput: t.output, toolDone: true } : {}),
    ...(t.isError !== undefined ? { isError: t.isError } : {}),
    ...(t.timestamp !== undefined ? { toolStartedAt: t.timestamp } : {}),
    ...(t.completedAt !== undefined ? { toolCompletedAt: t.completedAt } : {})
  };
}

export function SubagentToolList({
  tools,
  toolCount,
  turnId,
  basePath,
  sessionId,
  onPreview
}: {
  tools: SubagentToolActivity[];
  toolCount: number;
  turnId: string;
  basePath?: string;
  sessionId?: string;
  onPreview?: (path: string) => void;
}) {
  return (
    <>
      {tools.length > 0 && (
        <div className="suba-tools">
          {tools.map((tool) => (
            <ToolCard
              key={tool.id}
              message={subagentToolMessage(tool, turnId)}
              basePath={basePath}
              sessionId={sessionId}
              onPreview={onPreview}
              defaultOpen={tool.isError === true}
            />
          ))}
        </div>
      )}
      {toolCount > tools.length && (
        <div className="suba-tools-more">+{toolCount - tools.length} earlier tool calls not shown</div>
      )}
    </>
  );
}

function rowStatus(status: SubagentInfo["status"]): ToolStatus {
  if (status === "completed") return "complete";
  return status;
}

function metricText(item: SubagentInfo, toolCount: number): string | undefined {
  const parts: string[] = [];
  if (toolCount > 0) parts.push(toolCount === 1 ? "1 tool" : `${toolCount} tools`);
  if (item.counts?.tokens !== undefined) parts.push(`${formatTokensShort(item.counts.tokens)} tok`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function excerptOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > EXCERPT_MAX ? `${trimmed.slice(0, EXCERPT_MAX - 1)}…` : trimmed;
}

function flash(el: HTMLElement): void {
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), FLASH_MS);
}

function SubagentRow({ groupId, item }: { groupId: string; item: SubagentInfo }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const sessionId = useAppStore((s) => s.activeSessionId ?? undefined);
  const live = useAppStore((s) => (sessionId ? s.busyTurns[sessionId] !== undefined : false));
  const messages = useAppStore((s) =>
    open && sessionId ? (s.messagesBySession[sessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  );
  const fetched = useAppStore((s) =>
    sessionId && item.agentId ? s.subagentToolsByKey[`${sessionId}:${item.agentId}`] : undefined
  );
  const loadSubagentTools = useAppStore((s) => s.loadSubagentTools);
  const { basePath, openPreview } = useSessionWorkspace(sessionId);
  const running = item.status === "running";
  const ticking = running && live;
  const elapsed = useElapsed(item.startedAt, ticking);

  useEffect(() => {
    if (open && sessionId && item.agentId) void loadSubagentTools(sessionId, item.agentId);
  }, [open, sessionId, item.agentId, loadSubagentTools]);

  const { tools, toolCount } = subagentActivity(messages, item, fetched?.items);
  const shownCount = Math.max(toolCount, item.counts?.tools ?? 0);
  const metric = metricText(item, shownCount);
  const model = item.model ?? fetched?.model;
  const duration =
    ticking && item.startedAt !== undefined
      ? formatDuration(elapsed)
      : item.durationMs !== undefined
        ? formatToolDuration(item.durationMs)
        : undefined;
  const stateText =
    item.status === "running"
      ? duration !== undefined
        ? `Running for ${duration}`
        : "Running"
      : item.status === "error"
        ? "Failed"
        : duration !== undefined
          ? `Completed in ${duration}`
          : "Completed";
  const excerpt = item.output ? excerptOf(item.output) : item.prompt ? excerptOf(item.prompt) : undefined;

  return (
    <div id={subagentRowId(item.id)} className={`tool-card suba-row ${rowStatus(item.status)}${open ? " open" : ""}`}>
      <ToolRow
        status={rowStatus(item.status)}
        Icon={Bot}
        verb={item.agentType ?? "Agent"}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        controls={panelId}
        duration={duration}
        trailing={
          <button
            type="button"
            className="icon-btn tool-side-btn"
            title="Open in Agents panel"
            aria-label="Open in Agents panel"
            onClick={() => openAgentsPanel(groupId, item.id)}
          >
            <PanelRight size={13} aria-hidden="true" />
          </button>
        }
      >
        <span className="tool-subject suba-subject" title={item.name}>
          {item.name}
        </span>
        {metric !== undefined && <span className="tool-stat">{metric}</span>}
      </ToolRow>
      {open && (
        <div id={panelId} className="suba-panel">
          <div className="suba-panel-head">
            <span className={`suba-panel-state ${item.status}`}>{stateText}</span>
            {model && <span className="suba-badge model">{model}</span>}
            {item.counts?.effort && <span className="suba-badge">{item.counts.effort} effort</span>}
            <button type="button" className="suba-view" onClick={() => openAgentsPanel(groupId, item.id)}>
              View
              <ChevronRight size={12} aria-hidden="true" />
            </button>
          </div>
          <SubagentToolList
            tools={tools}
            toolCount={toolCount}
            turnId={item.turnId}
            basePath={basePath}
            sessionId={sessionId}
            onPreview={sessionId ? openPreview : undefined}
          />
          {tools.length === 0 && toolCount === 0 && (
            <div className="suba-empty">{running ? "No tool calls recorded yet." : "No tool calls recorded."}</div>
          )}
          {excerpt !== undefined && (
            <div className="suba-excerpt">
              <div className={`tool-output-label${item.status === "error" ? " error" : ""}`}>
                {item.output ? (item.status === "error" ? "error" : "result") : "task"}
              </div>
              <p className="suba-excerpt-text">{excerpt}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const SubagentCard = memo(function SubagentCard({ group }: { group: SubagentGroup }) {
  useEffect(() => {
    const onShow = (e: Event) => {
      const detail = (e as CustomEvent<{ groupId?: string; agentId?: string }>).detail;
      if (detail?.groupId !== group.id) return;
      const target =
        (detail.agentId ? document.getElementById(subagentRowId(detail.agentId)) : null) ??
        document.getElementById(subagentAnchorId(group.id));
      if (target) flash(target);
    };
    window.addEventListener("cw:show-subagent", onShow as EventListener);
    return () => window.removeEventListener("cw:show-subagent", onShow as EventListener);
  }, [group.id]);

  return (
    <div id={subagentAnchorId(group.id)} className="suba-group">
      {group.items.map((item) => (
        <SubagentRow key={item.id} groupId={group.id} item={item} />
      ))}
    </div>
  );
});
