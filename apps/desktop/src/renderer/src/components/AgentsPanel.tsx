import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDot, Copy, TriangleAlert } from "lucide-react";
import type { SubagentGroup, SubagentInfo } from "./subagents.js";
import { collectAgentMessages, formatSubagentCount, formatTokensShort, groupSubagents, mergeSubagentTools } from "./subagents.js";
import type { SubagentToolActivity } from "../cw.js";
import { describeToolCall, formatDuration, orderToolsForDisplay } from "./toolSummaries.js";
import { formatFileSubject, looksLikeFileMention } from "./pathDisplay.js";
import { Md } from "./Markdown.js";
import { ToolCard } from "./ToolCard.js";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";
import { subagentAnchorId } from "./SubagentCard.js";

export interface AgentsTarget {
  groupId?: string;
  agentId?: string;
}

const EMPTY_MESSAGES: ChatMessage[] = [];

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

function metaLine(item: SubagentInfo, fallbackModel?: string): string {
  const parts: string[] = [];
  const model = item.model ?? fallbackModel;
  if (model) parts.push(model);
  if (item.counts?.effort) parts.push(`${item.counts.effort} effort`);
  if (item.counts?.tokens !== undefined) parts.push(`${formatTokensShort(item.counts.tokens)} tok`);
  if (item.counts?.tools !== undefined) parts.push(`${item.counts.tools} tools`);
  return parts.join(" · ");
}

function statusLabel(status: SubagentInfo["status"]): string {
  if (status === "completed") return "completed";
  if (status === "running") return "running";
  return "error";
}

function StatusIcon({ status, size = 13 }: { status: SubagentInfo["status"]; size?: number }) {
  if (status === "completed") return <Check aria-hidden="true" size={size} strokeWidth={2.25} />;
  if (status === "running") return <CircleDot aria-hidden="true" size={size} strokeWidth={2.25} />;
  return <TriangleAlert aria-hidden="true" size={size} strokeWidth={2.25} />;
}

function RunningElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span>{formatDuration(Math.max(0, now - startedAt))}</span>;
}

function AgentDuration({ item, live }: { item: SubagentInfo; live: boolean }) {
  if (item.status === "running" && live && item.startedAt !== undefined) {
    return <RunningElapsed startedAt={item.startedAt} />;
  }
  return item.durationMs !== undefined ? <span>{formatDuration(item.durationMs)}</span> : null;
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

function toolSubject(t: SubagentToolActivity, basePath?: string, homeDir?: string): string {
  const summary = describeToolCall(t.name, t.input);
  if (!summary?.subject) return "";
  return summary.subjectKind === "file" || looksLikeFileMention(summary.subject)
    ? formatFileSubject(summary.subject, basePath, homeDir)
    : summary.subject;
}

function ClampedText({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={`agents-clamp${open ? " is-open" : ""}`}>
        <Md text={text} />
        {!open && <span className="agents-fade" />}
      </div>
      <button className="agents-more" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? "Collapse" : `Show full ${label}`}
      </button>
    </>
  );
}

function AgentToolList({
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
  sessionId: string;
  onPreview: (path: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const homeDir = useAppStore((s) => s.homeDir);
  return (
    <>
      <div className="agents-tool-list">
        {tools.map((tool) => {
          const status = toolStatus(tool);
          const summary = describeToolCall(tool.name, tool.input);
          const Icon = summary?.Icon ?? CircleDot;
          const verb = summary?.verb ?? tool.name;
          const subject = toolSubject(tool, basePath, homeDir ?? undefined);
          const duration =
            tool.timestamp !== undefined && tool.completedAt !== undefined && tool.completedAt >= tool.timestamp
              ? tool.completedAt - tool.timestamp
              : undefined;
          const open = expandedId === tool.id;
          return (
            <div key={tool.id}>
              <button
                type="button"
                className="agents-tool-row"
                aria-expanded={open}
                onClick={() => setExpandedId(open ? null : tool.id)}
              >
                <span className={`agents-tool-icon ${status}`}>
                  <Icon aria-hidden="true" size={13} />
                </span>
                <span className="agents-tool-verb">{verb}</span>
                <span className="agents-tool-subject" title={subject}>
                  {subject}
                </span>
                <span className="agents-tool-duration">
                  {duration !== undefined ? formatDuration(duration) : status === "running" ? "running" : ""}
                </span>
                {open ? (
                  <ChevronDown aria-hidden="true" size={14} />
                ) : (
                  <ChevronRight aria-hidden="true" size={14} />
                )}
              </button>
              {open && (
                <div className="agents-tool-detail">
                  <ToolCard
                    message={toChatMessage(tool, turnId)}
                    basePath={basePath}
                    sessionId={sessionId}
                    onPreview={onPreview}
                    defaultOpen
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {toolCount > tools.length && (
        <div className="agents-tool-more">+{toolCount - tools.length} earlier tool calls not shown</div>
      )}
    </>
  );
}

function AgentDetail({
  groupId,
  item,
  index,
  total,
  live,
  basePath,
  sessionId,
  messages,
  fetchedTools,
  fetchedModel,
  onBack,
  onPreview
}: {
  groupId: string;
  item: SubagentInfo;
  index: number;
  total: number;
  live: boolean;
  basePath?: string;
  sessionId: string;
  messages: ChatMessage[];
  fetchedTools: SubagentToolActivity[] | undefined;
  fetchedModel: string | undefined;
  onBack: () => void;
  onPreview: (path: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const model = item.model ?? fetchedModel;
  const nested = collectAgentMessages(messages, item.id);
  const directives = nested.filter((m) => m.toolName?.toLowerCase() === "sendmessage");
  const liveTools = nested.filter((m) => m.role === "tool" && m.toolName && m.toolName !== "result");
  const tools = mergeSubagentTools(liveTools, [...(item.tools ?? []), ...(fetchedTools ?? [])]);
  const toolCount = Math.max(item.toolCount, tools.length);

  return (
    <div className="agents-detail">
      <div className="agents-backrow">
        <button className="agents-back" type="button" onClick={onBack}>
          <ChevronLeft aria-hidden="true" size={14} />
          All subagents
        </button>
        <span className="agents-crumb">
          Agent {index + 1} of {total}
        </span>
      </div>

      <div className="agents-hero">
        <div className="agents-hero-top">
          <span className="agents-hero-badge">
            <Bot aria-hidden="true" size={16} />
          </span>
          <h3 className="agents-hero-name" title={item.name}>
            {item.name}
          </h3>
        </div>
        <div className="agents-hero-chips">
          {item.agentType && <span className="suba-badge">{item.agentType}</span>}
          {model && <span className="suba-badge model">{model}</span>}
          {item.counts?.effort && <span className="suba-badge">{item.counts.effort} effort</span>}
          {item.counts?.tokens !== undefined && (
            <span className="suba-badge">{formatTokensShort(item.counts.tokens)} tok</span>
          )}
          {toolCount > 0 && <span className="suba-badge">{toolCount} tools</span>}
          <span className={`agents-hero-state ${item.status}`}>
            <span className={`suba-dot ${item.status}`} />
            {statusLabel(item.status)}
            {item.status === "running" && live && item.startedAt !== undefined ? (
              <>
                {" · "}
                <RunningElapsed startedAt={item.startedAt} />
              </>
            ) : item.durationMs !== undefined ? (
              <> · {formatDuration(item.durationMs)}</>
            ) : null}
          </span>
        </div>
        <div className="agents-actions">
          {item.prompt && (
            <button
              className="btn"
              type="button"
              onClick={() => {
                copyText(item.prompt ?? "");
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
              {copied ? "Copied" : "Copy prompt"}
            </button>
          )}
          <button className="btn" type="button" onClick={() => jumpToSubagentGroup(groupId, item.id)}>
            Show in thread
          </button>
        </div>
      </div>

      {item.prompt && (
        <section className="agents-section">
          <h4 className="agents-section-title">Prompt</h4>
          <ClampedText text={item.prompt} label="prompt" />
        </section>
      )}

      {item.output && (
        <section className="agents-section">
          <h4 className="agents-section-title">Result</h4>
          <ClampedText text={item.output} label="result" />
        </section>
      )}

      <section className="agents-section">
        <h4 className="agents-section-title">
          Tool calls
          {toolCount > 0 && <span className="agents-section-count">{toolCount}</span>}
        </h4>
        {tools.length > 0 ? (
          <AgentToolList
            tools={tools}
            toolCount={toolCount}
            turnId={item.turnId}
            basePath={basePath}
            sessionId={sessionId}
            onPreview={onPreview}
          />
        ) : (
          <div className="agents-section-empty">
            {item.status === "running" ? "No tool calls recorded yet." : "No tool calls recorded."}
          </div>
        )}
      </section>

      {directives.length > 0 && (
        <section className="agents-section">
          <h4 className="agents-section-title">
            Messages
            <span className="agents-section-count">{directives.length}</span>
          </h4>
          <div className="agents-tool-list">
            {directives.map((message) => (
              <ToolCard
                key={message.id}
                message={message}
                basePath={basePath}
                sessionId={sessionId}
                onPreview={onPreview}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function AgentsPanel({ sessionId }: { sessionId: string }) {
  const messages = useAppStore((s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES);
  const live = useAppStore((s) => s.busyTurns[sessionId] !== undefined);
  const subagentToolsByKey = useAppStore((s) => s.subagentToolsByKey);
  const loadSubagentTools = useAppStore((s) => s.loadSubagentTools);
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
  const [view, setView] = useState<"list" | "detail">("list");
  const bodyRef = useRef<HTMLDivElement>(null);

  const ordered = orderToolsForDisplay(messages);
  const groups: SubagentGroup[] = groupSubagents(ordered);
  const entries = groups.flatMap((group) => group.items.map((item) => ({ groupId: group.id, item })));
  const total = entries.length;
  const running = entries.filter(({ item }) => item.status === "running").length;
  const selectedIndex = entries.findIndex(({ item }) => item.id === selectedId);
  const selected = selectedIndex >= 0 ? entries[selectedIndex] : entries[0];
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const agentId = selected?.item.agentId;
  const fetched = agentId ? subagentToolsByKey[`${sessionId}:${agentId}`] : undefined;
  const fetchedTools = fetched?.items;
  const fetchedModelFor = (item: SubagentInfo): string | undefined =>
    item.agentId ? subagentToolsByKey[`${sessionId}:${item.agentId}`]?.model : undefined;
  const agentKey = entries
    .map(({ item }) => (item.agentId ? `${item.id}:${item.agentId}` : ""))
    .join("|");

  useEffect(() => {
    for (const { item } of entriesRef.current) {
      if (item.agentId) void loadSubagentTools(sessionId, item.agentId);
    }
  }, [sessionId, agentKey, loadSubagentTools]);

  useEffect(() => {
    const applyTarget = (detail: AgentsTarget | undefined) => {
      const target = detail?.agentId
        ? entriesRef.current.find(({ item }) => item.id === detail.agentId)
        : detail?.groupId
          ? entriesRef.current.find(({ groupId }) => groupId === detail.groupId)
          : undefined;
      if (!target) return;
      setSelectedId(target.item.id);
      setView("detail");
      window.setTimeout(() => {
        const el = document.getElementById(`agents-row-${target.item.id}`);
        if (!el) return;
        el.classList.add("flash");
        window.setTimeout(() => el.classList.remove("flash"), 1600);
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
      {view === "list" || !selected ? (
        <div ref={bodyRef} className="agents-list">
          <div className="agents-head">
            <span className="agents-head-title">Subagents</span>
            <span className="agents-head-count">{total === 0 ? "none" : formatSubagentCount(total)}</span>
            {running > 0 && (
              <span className="agents-running">
                <span className="pulse" />
                {running} running
              </span>
            )}
          </div>
          {total === 0 && (
            <div className="agents-empty">
              <div className="empty-mark">
                <Bot aria-hidden="true" size={22} />
              </div>
              <div>No subagents in this session yet.</div>
              <div className="agents-empty-sub">Spawned Task / Agent tools will appear here.</div>
            </div>
          )}
          {entries.map(({ item }) => {
            const meta = metaLine(item, fetchedModelFor(item));
            return (
              <button
                key={item.id}
                id={`agents-row-${item.id}`}
                type="button"
                className="agents-row"
                onClick={() => {
                  setSelectedId(item.id);
                  setView("detail");
                }}
              >
                <span className={`suba-dot ${item.status}`} />
                <span className="agents-row-main">
                  <span className="agents-row-nameline">
                    <span className="agents-row-name" title={item.name}>
                      {item.name}
                    </span>
                    {item.agentType && <span className="suba-badge">{item.agentType}</span>}
                  </span>
                  <span className="agents-row-excerpt" title={item.summary}>
                    {item.summary}
                  </span>
                  {meta && <span className="agents-row-meta">{meta}</span>}
                </span>
                <span className="agents-row-right">
                  <AgentDuration item={item} live={live} />
                </span>
                <span className="agents-row-chev">
                  <ChevronRight aria-hidden="true" size={14} />
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <AgentDetail
          key={selected.item.id}
          groupId={selected.groupId}
          item={selected.item}
          index={selectedIndex >= 0 ? selectedIndex : 0}
          total={total}
          live={live}
          basePath={basePath}
          sessionId={sessionId}
          messages={messages}
          fetchedTools={fetchedTools}
          fetchedModel={fetched?.model}
          onBack={() => setView("list")}
          onPreview={(p) => openPreview(sessionId, p, basePath ?? "")}
        />
      )}
    </div>
  );
}
