import { useCallback, useEffect, useMemo, useRef } from "react";
import { PanelRightClose, PanelRightOpen, Sparkles, TriangleAlert } from "lucide-react";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";
import { Notifications } from "./Notifications.js";
import { Md } from "./Markdown.js";
import { DriverIcon } from "./DriverIcon.js";
import { Composer } from "./Composer.js";
import { GitPanelBar } from "./GitPanelBar.js";
import { ToolCard } from "./ToolCard.js";
import { SubagentCard } from "./SubagentCard.js";
import { NewThread } from "./NewThread.js";
import { ApprovalDock } from "./ApprovalDock.js";
import { QuestionDock } from "./QuestionDock.js";
import { WorkingPill, useWorkingWord } from "./WorkingPill.js";
import { formatDuration, orderToolsForDisplay } from "./toolSummaries.js";
import { collectSubagents, describeSubagent, isSubagentMessage, type SubagentGroup } from "./subagents.js";
import { splitImageMentions } from "./imagePreview.js";
import { ImageThumb } from "./ImageThumb.js";

const EMPTY_MESSAGES: ChatMessage[] = [];

export function ThreadView({ rightVisible, onToggleRight }: { rightVisible: boolean; onToggleRight: () => void }) {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const pendingDriver = useAppStore((s) => s.pendingDriver);
  const lastDriver = useAppStore((s) => s.lastDriver);
  const session = useAppStore((s) => {
    if (!activeSessionId) return undefined;
    for (const list of Object.values(s.sessionsByProject)) {
      const found = list.find((item) => item.id === activeSessionId);
      if (found) return found;
    }
    return undefined;
  });
  const project = useAppStore((s) => s.projects.find((p) => p.id === activeProjectId));
  const messages = useAppStore((s) =>
    activeSessionId ? (s.messagesBySession[activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  );
  const busyTurn = useAppStore((s) => (activeSessionId ? s.busyTurns[activeSessionId] : undefined));
  const usage = useAppStore((s) => (activeSessionId ? s.usageBySession[activeSessionId] : undefined));
  const lastTurn = useAppStore((s) => (activeSessionId ? s.lastTurnStats[activeSessionId] : undefined));
  const openPreview = useAppStore((s) => s.openPreview);
  const setPendingDriver = useAppStore((s) => s.setPendingDriver);
  const ordered = useMemo(() => orderToolsForDisplay(messages), [messages]);
  const subagents = useMemo(() => collectSubagents(messages), [messages]);
  const nestedIds = useMemo(() => new Set(subagents.map((s) => s.id)), [subagents]);
  const nodes: Array<{ kind: "msg"; msg: ChatMessage } | { kind: "sub"; key: string; group: SubagentGroup }> = useMemo(() => {
    const out: Array<{ kind: "msg"; msg: ChatMessage } | { kind: "sub"; key: string; group: SubagentGroup }> = [];
    let pending: ChatMessage[] = [];
    const flush = () => {
      if (pending.length > 0) {
        out.push({
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
        out.push({ kind: "msg", msg: m });
      }
    }
    flush();
    return out;
  }, [ordered, nestedIds]);
  const streamingId = useMemo(() => {
    if (!busyTurn) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.turnId === busyTurn) return m.id;
    }
    return null;
  }, [messages, busyTurn]);
  const showNew = pendingDriver !== null || !session;
  const workingWord = useWorkingWord(!showNew && !!busyTurn);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const sessionId = session?.id;
  const projectRoot = project?.rootPath ?? "";
  const onOpenPreview = useCallback(
    (path: string) => {
      if (sessionId) openPreview(sessionId, path, projectRoot);
    },
    [openPreview, sessionId, projectRoot]
  );

  useEffect(() => {
    stickRef.current = true;
  }, [activeSessionId]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
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
          <span className="thread-avatar" aria-hidden="true">
            {(project?.name ?? "cw").slice(0, 2).toUpperCase()}
          </span>
          <span className="crumb" title={`${project?.name ?? ""} / New thread`}>
            <span>{project?.name ?? "…"}</span>
            <span className="crumb-sep">/</span>
            <strong>New thread</strong>
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
          onDriverChange={setPendingDriver}
        />
      </div>
    );
  }

  return (
    <div className="thread-col">
      <div className="thread-head">
        <span className="thread-avatar" aria-hidden="true">
          {(project?.name ?? "cw").slice(0, 2).toUpperCase()}
        </span>
        <span className="crumb" title={`${project?.name ?? ""} / ${session.title}`}>
          <span>{project?.name ?? "…"}</span>
          <span className="crumb-sep">/</span>
          <strong>{session.title}</strong>
        </span>
        <GitPanelBar sessionId={session.id} compact />
        <span className="thread-status">
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
                  onPreview={onOpenPreview}
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
            if (m.id === streamingId) {
              return (
                <div key={m.id} className="msg-assistant">
                  <div className="md md-streaming" style={{ whiteSpace: "pre-wrap" }}>
                    {m.text}
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className="msg-assistant">
                <Md text={m.text} onOpenFile={onOpenPreview} />
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
