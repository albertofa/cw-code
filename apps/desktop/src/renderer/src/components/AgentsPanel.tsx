import { Fragment, useEffect, useRef, useState } from "react";
import type { SubagentGroup, SubagentInfo } from "./subagents.js";
import { collectAgentMessages, formatSubagentCount, formatTokensShort, groupSubagents } from "./subagents.js";
import { describeToolCall, formatDuration, orderToolsForDisplay, relativizeToBase } from "./toolSummaries.js";
import { Md } from "./Markdown.js";
import { ToolCard } from "./ToolCard.js";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";
import type { SubagentToolActivity } from "../cw.js";
import { subagentAnchorId } from "./SubagentCard.js";

export interface AgentsTarget {
  groupId?: string;
  agentId?: string;
}

let pendingTarget: AgentsTarget | null = null;

export function openAgentsPanel(groupId?: string, agentId?: string): void {
  pendingTarget = { groupId, agentId };
  window.dispatchEvent(new CustomEvent("cw:open-agents", { detail: pendingTarget }));
}

export function jumpToSubagentGroup(groupId: string, agentId?: string): void {
  window.dispatchEvent(new CustomEvent("cw:show-subagent", { detail: { groupId, agentId } }));
  window.setTimeout(() => {
    const el = document.getElementById(subagentAnchorId(groupId));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 60);
}

function copyText(text: string): void {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable — selection still works */
  }
}

function metaLine(item: SubagentInfo): string {
  const parts: string[] = [];
  if (item.model) parts.push(item.model);
  if (item.counts?.effort) parts.push(item.counts.effort);
  if (item.counts?.tokens !== undefined) parts.push(`${formatTokensShort(item.counts.tokens)} tok`);
  if (item.counts?.tools !== undefined) parts.push(`${item.counts.tools} tools`);
  return parts.join(" · ");
}

function RunningElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="suba-dur">{formatDuration(Math.max(0, now - startedAt))}</span>;
}

function toChatMessage(t: SubagentToolActivity, turnId: string): ChatMessage {
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

function toolStatus(t: SubagentToolActivity): "running" | "completed" | "error" {
  if (t.isError) return "error";
  return t.output !== undefined ? "completed" : "running";
}

function toolSummary(t: SubagentToolActivity, basePath?: string): string {
  const summary = describeToolCall(t.name, t.input);
  if (!summary) return t.name;
  const subject = summary.subjectKind === "file" && summary.subject && basePath
    ? relativizeToBase(basePath, summary.subject)
    : summary.subject;
  return subject ? `${summary.verb} ${subject}` : summary.verb;
}

function AgentRow({
  groupId,
  item,
  expanded,
  live,
  basePath,
  sessionId,
  onPreview,
  onToggle
}: {
  groupId: string;
  item: SubagentInfo;
  expanded: boolean;
  live: boolean;
  basePath?: string;
  sessionId: string;
  onPreview: (path: string) => void;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set());
  const meta = metaLine(item);
  const directives = collectAgentMessages(
    useAppStore((s) => s.messagesBySession[sessionId] ?? []),
    item.id
  );
  return (
    <div id={`agents-row-${item.id}`} className="agents-row">
      <div className="agents-row-head" onClick={onToggle} title={expanded ? "Collapse" : "Expand"}>
        <span className={`suba-dot ${item.status}`} />
        <span className="agents-name" title={item.name}>
          {item.name}
        </span>
        {item.agentType && <span className="suba-badge">{item.agentType}</span>}
        <span className="agents-right">
          {item.status === "running" && live && item.startedAt !== undefined ? (
            <RunningElapsed startedAt={item.startedAt} />
          ) : (
            item.durationMs !== undefined && <span className="suba-dur">{formatDuration(item.durationMs)}</span>
          )}
          <span className={`suba-check ${item.status}`}>
            {item.status === "completed" ? "✓" : item.status === "running" ? "●" : "⚠"}
          </span>
        </span>
      </div>
      <div className="suba-excerpt" title={item.summary}>
        {item.summary}
      </div>
      {meta && <div className="suba-meta">{meta}</div>}
      {expanded && (
        <div className="agents-detail" onClick={(e) => e.stopPropagation()}>
          {item.prompt && (
            <>
              <div className="tool-output-label">prompt</div>
              <div className="agents-md">
                <Md text={item.prompt} />
              </div>
            </>
          )}
          {item.output && (
            <>
              <div className="tool-output-label">output</div>
              <div className="agents-md">
                <Md text={item.output.slice(0, 4000)} />
              </div>
            </>
          )}
          {(item.toolCount > 0 || item.tools.length > 0) && (
            <div className="agents-tool-calls">
              <button
                type="button"
                className="agents-tool-disclosure"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen((open) => !open)}
              >
                <span className="tool-caret">{toolsOpen ? "▾" : "▸"}</span>
                Tool calls ({item.toolCount})
              </button>
              {toolsOpen && (
                <div className="agents-tool-table-wrap">
                  <table className="agents-tool-table">
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Tool call</th>
                        <th>Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.tools.map((t) => {
                        const status = toolStatus(t);
                        const rowOpen = expandedToolIds.has(t.id);
                        const summary = toolSummary(t, basePath);
                        const duration = t.timestamp !== undefined && t.completedAt !== undefined && t.completedAt >= t.timestamp
                          ? t.completedAt - t.timestamp
                          : undefined;
                        const toggle = () => {
                          setExpandedToolIds((ids) => {
                            const next = new Set(ids);
                            if (next.has(t.id)) next.delete(t.id);
                            else next.add(t.id);
                            return next;
                          });
                        };
                        return (
                          <Fragment key={t.id}>
                            <tr
                              className={`agents-tool-row ${status}`}
                              tabIndex={0}
                              aria-expanded={rowOpen}
                              onClick={toggle}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                toggle();
                              }}
                            >
                              <td>
                                <span className={`agents-tool-status ${status}`}>
                                  {status === "completed" ? "✓ Completed" : status === "running" ? "● Running" : "⚠ Error"}
                                </span>
                              </td>
                              <td className="agents-tool-summary" title={summary}>
                                <span className="tool-caret">{rowOpen ? "▾" : "▸"}</span>
                                {summary}
                              </td>
                              <td className="agents-tool-duration">
                                {duration !== undefined ? (
                                  formatDuration(duration)
                                ) : status === "running" && live && t.timestamp !== undefined ? (
                                  <RunningElapsed startedAt={t.timestamp} />
                                ) : (
                                  "-"
                                )}
                              </td>
                            </tr>
                            {rowOpen && (
                              <tr className="agents-tool-detail-row">
                                <td colSpan={3} onClick={(event) => event.stopPropagation()}>
                                  <ToolCard
                                    message={toChatMessage(t, item.turnId)}
                                    basePath={basePath}
                                    sessionId={sessionId}
                                    onPreview={onPreview}
                                    defaultOpen
                                  />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  {item.toolCount > item.tools.length && (
                    <div className="suba-meta">+{item.toolCount - item.tools.length} more</div>
                  )}
                </div>
              )}
            </div>
          )}
          {directives.length > 0 && (
            <>
              <div className="tool-output-label">messages</div>
              <div className="agents-tools">
                {directives.map((dm) => (
                  <ToolCard
                    key={dm.id}
                    message={dm}
                    basePath={basePath}
                    sessionId={sessionId}
                    onPreview={onPreview}
                  />
                ))}
              </div>
            </>
          )}
          <div className="agents-actions">
            {item.prompt && (
              <button
                className="btn"
                onClick={() => {
                  copyText(item.prompt ?? "");
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "✓ Copied" : "Copy prompt"}
              </button>
            )}
            <button className="btn" onClick={() => jumpToSubagentGroup(groupId, item.id)}>
              Show in thread
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentsPanel({ sessionId }: { sessionId: string }) {
  const messages = useAppStore((s) => s.messagesBySession[sessionId] ?? []);
  const live = useAppStore((s) => s.busyTurns[sessionId] !== undefined);
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const openPreview = useAppStore((s) => s.openPreview);
  const basePath = projects.find((p) => p.id === activeProjectId)?.rootPath;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const ordered = orderToolsForDisplay(messages);
  const groups = groupSubagents(ordered);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const running = groups.reduce((n, g) => n + g.items.filter((i) => i.status === "running").length, 0);
  const groupsRef = useRef<SubagentGroup[]>([]);
  groupsRef.current = groups;
  const prevTotalRef = useRef(total);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, []);
  useEffect(() => {
    if (total > prevTotalRef.current) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
    prevTotalRef.current = total;
  }, [total]);

  useEffect(() => {
    const applyTarget = (detail: AgentsTarget | undefined) => {
      const targetId =
        detail?.agentId ?? groupsRef.current.find((g) => g.id === detail?.groupId)?.items[0]?.id;
      if (targetId) setExpandedId(targetId);
      window.setTimeout(() => {
        const el = targetId ? document.getElementById(`agents-row-${targetId}`) : null;
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
          el.classList.add("flash");
          window.setTimeout(() => el.classList.remove("flash"), 1600);
        } else {
          bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
        }
      }, 60);
    };
    if (pendingTarget) {
      const target = pendingTarget;
      pendingTarget = null;
      applyTarget(target);
    }
    const onOpen = (e: Event) => {
      pendingTarget = null;
      applyTarget((e as CustomEvent<AgentsTarget>).detail);
    };
    window.addEventListener("cw:open-agents", onOpen as EventListener);
    return () => window.removeEventListener("cw:open-agents", onOpen as EventListener);
  }, []);

  return (
    <div className="agents-panel">
      <div className="agents-section">
        SUBAGENTS · {formatSubagentCount(total)}
        {running > 0 && (
          <span className="agents-running">
            {" "}
            · <span className="pulse" /> {running} running
          </span>
        )}
      </div>
      <div ref={bodyRef} className="agents-list">
        {total === 0 && (
          <div className="agents-empty">
            <div className="empty-mark">✳</div>
            <div>No subagents in this session yet.</div>
            <div className="agents-empty-sub">Spawned Task / Agent tools will appear here.</div>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.id}>
            {g.items.map((item) => (
              <AgentRow
                key={item.id}
                groupId={g.id}
                item={item}
                expanded={expandedId === item.id}
                live={live}
                basePath={basePath}
                sessionId={sessionId}
                onPreview={(p) => openPreview(sessionId, p, basePath ?? "")}
                onToggle={() => setExpandedId((id) => (id === item.id ? null : item.id))}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
