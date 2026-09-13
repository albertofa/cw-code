import { useEffect, useRef } from "react";
import { Bot, PanelRightClose, PanelRightOpen, Sparkles, TriangleAlert } from "lucide-react";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";
import { Notifications } from "./Notifications.js";
import { Md } from "./Markdown.js";
import { DriverIcon } from "./DriverIcon.js";
import { Composer } from "./Composer.js";
import { GitPanelBar } from "./GitPanelBar.js";
import { ToolCard } from "./ToolCard.js";
import { SubagentCard } from "./SubagentCard.js";
import { openAgentsPanel } from "./AgentsPanel.js";
import { NewThread } from "./NewThread.js";
import { ApprovalDock } from "./ApprovalDock.js";
import { QuestionDock } from "./QuestionDock.js";
import { WorkingPill, useWorkingWord } from "./WorkingPill.js";
import { formatDuration, orderToolsForDisplay } from "./toolSummaries.js";
import { collectSubagents, describeSubagent, isSubagentMessage, type SubagentGroup } from "./subagents.js";
import { splitImageMentions } from "./imagePreview.js";
import { ImageThumb } from "./ImageThumb.js";

export function ThreadView({ rightVisible, onToggleRight }: { rightVisible: boolean; onToggleRight: () => void }) {
  const {
    projects,
    sessionsByProject,
    activeProjectId,
    activeSessionId,
    messagesBySession,
    busyTurns,
    usageBySession,
    pendingDriver,
    lastDriver,
    lastTurnStats,
  } = useAppStore();
  const store = useAppStore();

  const session = Object.values(sessionsByProject).flat().find((s) => s.id === activeSessionId);
  const project = projects.find((p) => p.id === activeProjectId);
  const messages = activeSessionId ? (messagesBySession[activeSessionId] ?? []) : [];
  const busyTurn = activeSessionId ? busyTurns[activeSessionId] : undefined;
  const usage = activeSessionId ? usageBySession[activeSessionId] : undefined;
  const lastTurn = activeSessionId ? lastTurnStats[activeSessionId] : undefined;
  const ordered = orderToolsForDisplay(messages);
  const subagents = collectSubagents(messages);
  const subagentsRunning = subagents.filter((s) => s.status === "running").length;
  const nestedIds = new Set(subagents.map((s) => s.id));
  const nodes: Array<{ kind: "msg"; msg: ChatMessage } | { kind: "sub"; key: string; group: SubagentGroup }> = [];
  {
    let pending: ChatMessage[] = [];
    const flush = () => {
      if (pending.length > 0) {
        nodes.push({
          kind: "sub",
          key: pending[0].id,
          group: { id: pending[0].id, turnId: pending[0].turnId, items: pending.map(describeSubagent) }
        });
        pending = [];
      }
    };
    for (const m of ordered) {
      if (isSubagentMessage(m)) pending.push(m);
      else if (m.parentToolCallId && nestedIds.has(m.parentToolCallId)) continue;
      else {
        flush();
        nodes.push({ kind: "msg", msg: m });
      }
    }
    flush();
  }
  const showNew = pendingDriver !== null || !session;
  const workingWord = useWorkingWord(!showNew && !!busyTurn);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    stickRef.current = true;
  }, [activeSessionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, busyTurn, lastTurn]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };

  if (showNew) {
    const heroDriver = pendingDriver ?? session?.driver ?? lastDriver;
    return (
      <div className="thread-col">
        <div className="thread-head">
          <span className="crumb" title={`${project?.name ?? ""} / New thread`}>
            {project?.name ?? "…"} / <strong>New thread</strong>
          </span>
          <span title={heroDriver}>
            <DriverIcon driver={heroDriver} size={14} />
          </span>
          <span className="thread-status">
            <button className="icon-btn" onClick={onToggleRight} title={rightVisible ? "Hide panel" : "Show panel"}>
              {rightVisible ? <PanelRightClose aria-hidden="true" size={14} /> : <PanelRightOpen aria-hidden="true" size={14} />}
            </button>
          </span>
        </div>
        <Notifications />
        <NewThread
          key={activeProjectId}
          projectId={activeProjectId ?? ""}
          projectName={project?.name ?? "this project"}
          driver={heroDriver}
          onDriverChange={(d) => store.setPendingDriver(d)}
        />
      </div>
    );
  }

  return (
    <div className="thread-col">
      <div className="thread-head">
        <span className="crumb" title={`${project?.name ?? ""} / ${session.title}`}>
          {project?.name ?? "…"} / <strong>{session.title}</strong>
        </span>
        <span title={session.driver}>
          <DriverIcon driver={session.driver} size={14} />
        </span>
        <GitPanelBar sessionId={session.id} compact />
        <span className="thread-status">
          <button
            className={`icon-btn agents-btn${subagentsRunning > 0 ? " running" : ""}`}
            onClick={() => openAgentsPanel()}
            title={subagents.length > 0 ? `Subagents (${subagents.length})` : "Subagents"}
            aria-label="Subagents"
          >
            <Bot size={14} />
            {subagents.length > 0 && <span className="agents-count">{subagents.length}</span>}
          </button>
          {busyTurn && <WorkingPill word={workingWord} />}
          <button className="icon-btn" onClick={onToggleRight} title={rightVisible ? "Hide panel" : "Show panel"}>
            {rightVisible ? <PanelRightClose aria-hidden="true" size={14} /> : <PanelRightOpen aria-hidden="true" size={14} />}
          </button>
        </span>
      </div>
      <Notifications />
      <div className="thread-body">
        <div className="thread-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="thread-inner">
          {messages.length === 0 && !busyTurn && (
            <div className="empty">
              <div className="empty-mark"><Sparkles aria-hidden="true" size={22} /></div>
              <div>Prompt below to begin.</div>
            </div>
          )}
          {nodes.map((n) => {
            if (n.kind === "sub") {
              return <SubagentCard key={n.key} group={n.group} />;
            }
            const m = n.msg;
            if (m.role === "user") {
              return (
                <div key={m.id} className="msg-user">
                  {splitImageMentions(m.text).map((seg, i) =>
                    seg.kind === "image" ? (
                      <ImageThumb
                        key={i}
                        target={{ sessionId: session.id, projectId: project?.id }}
                        path={seg.path}
                        className="msg-image-thumb"
                      />
                    ) : (
                      <span key={i}>{seg.value}</span>
                    )
                  )}
                </div>
              );
            }
            if (m.role === "tool") {
              return (
                <ToolCard
                  key={m.id}
                  message={m}
                  basePath={project?.rootPath}
                  sessionId={session.id}
                  onPreview={(p) => store.openPreview(session.id, p, project?.rootPath ?? "")}
                />
              );
            }
            if (m.role === "system") {
              return (
                <div key={m.id} className="msg-system">
                  <TriangleAlert size={14} aria-hidden="true" />
                  <span>{m.text}</span>
                </div>
              );
            }
            return (
              <div key={m.id} className="msg-assistant">
                <Md text={m.text} onOpenFile={(p) => store.openPreview(session.id, p, project?.rootPath ?? "")} />
              </div>
            );
          })}
          {busyTurn && <WorkingPill word={workingWord} />}
          {!busyTurn && lastTurn && (
            <div className="turn-sep">Worked for {formatDuration(lastTurn.ms)}</div>
          )}
          </div>
        </div>
      {usage && (
        <div className="usage">
          in <b>{usage.inputTokens}</b> · out <b>{usage.outputTokens}</b> · <b>${usage.costUsd.toFixed(4)}</b> ·{" "}
          {usage.numTurns} turns
        </div>
      )}
      <div className="composer-wrap">
        <ApprovalDock sessionId={session.id} />
        <QuestionDock sessionId={session.id} />
        <Composer key={session.id} sessionId={session.id} driver={session.driver} />
      </div>
      </div>
    </div>
  );
}
