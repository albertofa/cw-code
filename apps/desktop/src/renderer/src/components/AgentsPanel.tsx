import { Fragment, useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, CircleDot, TriangleAlert } from "lucide-react";
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

function StatusIcon({ status }: { status: SubagentInfo["status"] }) {
  if (status === "completed") return <Check aria-hidden="true" size={14} strokeWidth={2.25} />;
  if (status === "running") return <CircleDot aria-hidden="true" size={13} strokeWidth={2.25} />;
  return <TriangleAlert aria-hidden="true" size={14} strokeWidth={2.25} />;
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

function AgentRosterItem({
  item,
  live,
  selected,
  onSelect
}: {
  item: SubagentInfo;
  live: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = metaLine(item);
  return (
    <button
      id={`agents-row-${item.id}`}
      type="button"
      className={`agents-row agents-roster-item${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
      title={`Inspect ${item.name}`}
    >
      <span className="agents-row-head">
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
            <StatusIcon status={item.status} />
          </span>
        </span>
      </span>
      <span className="suba-excerpt" title={item.summary}>
        {item.summary}
      </span>
      {meta && <span className="suba-meta">{meta}</span>}
    </button>
  );
}

function AgentInspector({
  groupId,
  item,
  live,
  basePath,
  sessionId,
  onPreview
}: {
  groupId: string;
  item: SubagentInfo;
  live: boolean;
  basePath?: string;
  sessionId: string;
  onPreview: (path: string) => void;
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
    <section className="agents-inspector" aria-label={`${item.name} details`}>
      <div className="agents-inspector-header">
        <span className={`suba-dot ${item.status}`} />
        <div className="agents-inspector-title">
          <span className="agents-name" title={item.name}>
            {item.name}
          </span>
          {item.agentType && <span className="suba-badge">{item.agentType}</span>}
        </div>
        <div className="agents-inspector-status">
          {item.status === "running" && live && item.startedAt !== undefined ? (
            <RunningElapsed startedAt={item.startedAt} />
          ) : (
            item.durationMs !== undefined && <span className="suba-dur">{formatDuration(item.durationMs)}</span>
          )}
          <span className={`suba-check ${item.status}`}>
            <StatusIcon status={item.status} />
          </span>
        </div>
      </div>
      <div className="agents-inspector-summary" title={item.summary}>
        {item.summary}
      </div>
      {meta && <div className="suba-meta agents-inspector-meta">{meta}</div>}
      <div className="agents-detail">
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
                {toolsOpen ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}
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
                                  {status === "completed" ? <Check aria-hidden="true" size={13} /> : status === "running" ? <CircleDot aria-hidden="true" size={12} /> : <TriangleAlert aria-hidden="true" size={13} />}
                                  {status === "completed" ? "Completed" : status === "running" ? "Running" : "Error"}
                                </span>
                              </td>
                              <td className="agents-tool-summary" title={summary}>
                                {rowOpen ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}
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
              {copied && <Check aria-hidden="true" size={14} />}
              {copied ? "Copied" : "Copy prompt"}
            </button>
          )}
          <button className="btn" onClick={() => jumpToSubagentGroup(groupId, item.id)}>
            Show in thread
          </button>
        </div>
      </div>
    </section>
  );
}

export function AgentsPanel({ sessionId }: { sessionId: string }) {
  const messages = useAppStore((s) => s.messagesBySession[sessionId] ?? []);
  const live = useAppStore((s) => s.busyTurns[sessionId] !== undefined);
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const openPreview = useAppStore((s) => s.openPreview);
  const basePath = (() => {
    for (const [pid, list] of Object.entries(sessionsByProject)) {
      const found = list.find((s) => s.id === sessionId);
      if (found) return found.worktreePath ?? projects.find((p) => p.id === pid)?.rootPath;
    }
    return projects.find((p) => p.id === activeProjectId)?.rootPath;
  })();
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      if (targetId) setSelectedId(targetId);
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

  const agentEntries = groups.flatMap((group) => group.items.map((item) => ({ groupId: group.id, item })));
  const selected = agentEntries.find(({ item }) => item.id === selectedId) ?? agentEntries[0];

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
      <div ref={bodyRef} className="agents-list agents-panel-body">
        {total === 0 && (
          <div className="agents-empty">
            <div className="empty-mark"><Bot aria-hidden="true" size={22} /></div>
            <div>No subagents in this session yet.</div>
            <div className="agents-empty-sub">Spawned Task / Agent tools will appear here.</div>
          </div>
        )}
        {total > 0 && (
          <div className="agents-roster" aria-label="Subagent roster">
            {groups.map((g) => (
              <div key={g.id} className="agents-roster-group">
                {g.items.map((item) => (
                  <AgentRosterItem
                    key={item.id}
                    item={item}
                    live={live}
                    selected={selected?.item.id === item.id}
                    onSelect={() => setSelectedId(item.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
        {selected && (
          <AgentInspector
            key={selected.item.id}
            groupId={selected.groupId}
            item={selected.item}
            live={live}
            basePath={basePath}
            sessionId={sessionId}
            onPreview={(p) => openPreview(sessionId, p, basePath ?? "")}
          />
        )}
      </div>
    </div>
  );
}
