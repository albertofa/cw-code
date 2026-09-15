import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Sparkles, TriangleAlert } from "lucide-react";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";
import { Notifications } from "./Notifications.js";
import { Md } from "./Markdown.js";
import { DriverIcon } from "./DriverIcon.js";
import { Composer } from "./Composer.js";
import { GitPanelBar } from "./GitPanelBar.js";
import { ToolCard } from "./ToolCard.js";
import { ToolGroupCard } from "./ToolGroupCard.js";
import { SubagentCard } from "./SubagentCard.js";
import { NewThread } from "./NewThread.js";
import { ApprovalDock } from "./ApprovalDock.js";
import { QuestionDock } from "./QuestionDock.js";
import { TodoDock } from "./TodoDock.js";
import { WorkingPill, useWorkingWord } from "./WorkingPill.js";
import { projectAvatarStyle, projectInitials } from "./avatar.js";
import { formatDuration, orderToolsForDisplay } from "./toolSummaries.js";
import { collectSubagents, describeSubagent, isSubagentMessage, type SubagentGroup } from "./subagents.js";
import { splitImageMentions } from "./imagePreview.js";
import { ImageThumb } from "./ImageThumb.js";

const EMPTY_MESSAGES: ChatMessage[] = [];

export function ThreadView() {
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
  const historyLoading = useAppStore((s) => (activeSessionId ? !!s.loadingHistory[activeSessionId] : false));
  const historyError = useAppStore((s) => (activeSessionId ? s.historyErrorBySession[activeSessionId] : undefined));
  const ensureHistory = useAppStore((s) => s.ensureHistory);
  const retryConnection = useAppStore((s) => s.retryConnection);
  const usage = useAppStore((s) => (activeSessionId ? s.usageBySession[activeSessionId] : undefined));
  const lastTurn = useAppStore((s) => (activeSessionId ? s.lastTurnStats[activeSessionId] : undefined));
  const openPreview = useAppStore((s) => s.openPreview);
  const setPendingDriver = useAppStore((s) => s.setPendingDriver);
  const ordered = useMemo(() => orderToolsForDisplay(messages), [messages]);
  const subagents = useMemo(() => collectSubagents(messages), [messages]);
  const nestedIds = useMemo(() => new Set(subagents.map((s) => s.id)), [subagents]);
  const nodes: Array<
    { kind: "msg"; msg: ChatMessage } | { kind: "sub"; key: string; group: SubagentGroup } | { kind: "tools"; key: string; items: ChatMessage[] }
  > = useMemo(() => {
    const out: Array<
      { kind: "msg"; msg: ChatMessage } | { kind: "sub"; key: string; group: SubagentGroup } | { kind: "tools"; key: string; items: ChatMessage[] }
    > = [];
    let pending: ChatMessage[] = [];
    let toolRun: ChatMessage[] = [];
    const isTodoTool = (m: ChatMessage) => {
      const n = (m.toolName ?? "").toLowerCase();
      return n === "todowrite" || n === "todo";
    };
    const flushTools = () => {
      if (toolRun.length === 1) out.push({ kind: "msg", msg: toolRun[0] });
      else if (toolRun.length > 1) out.push({ kind: "tools", key: toolRun[0].id, items: toolRun });
      toolRun = [];
    };
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
      if (isTodoTool(m)) continue;
      if (isSubagentMessage(m)) {
        flushTools();
        pending.push(m);
      }
      else if (m.parentToolCallId && nestedIds.has(m.parentToolCallId)) continue;
      else if (m.role === "tool") {
        flush();
        toolRun.push(m);
      }
      else {
        flush();
        flushTools();
        out.push({ kind: "msg", msg: m });
      }
    }
    flush();
    flushTools();
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
  const lastSeenIdRef = useRef<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const sessionId = session?.id;
  const basePath = session?.worktreePath ?? project?.rootPath ?? "";
  const onOpenPreview = useCallback(
    (path: string) => {
      if (sessionId) openPreview(sessionId, path, basePath);
    },
    [openPreview, sessionId, basePath]
  );

  useEffect(() => {
    stickRef.current = true;
    lastSeenIdRef.current = null;
    setAtBottom(true);
  }, [activeSessionId]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last && last.id !== lastSeenIdRef.current) {
      lastSeenIdRef.current = last.id;
      if (last.role === "user") stickRef.current = true;
    }
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, busyTurn, lastTurn]);

  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el || !(inner instanceof HTMLElement)) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [activeSessionId, showNew]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    stickRef.current = nearBottom;
    setAtBottom(nearBottom);
  };

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }, []);

  if (showNew) {
    const heroDriver = pendingDriver ?? session?.driver ?? lastDriver;
    const heroName = project?.name ?? "cw";
    return (
      <div className="thread-col">
        <div className="thread-head">
          <span className="thread-avatar" style={projectAvatarStyle(heroName)} aria-hidden="true">
            {projectInitials(heroName)}
          </span>
          <span className="crumb" title={`${project?.name ?? ""} / New thread`}>
            <span>{project?.name ?? "…"}</span>
            <span className="crumb-sep">/</span>
            <strong>New thread</strong>
          </span>
          <span title={heroDriver}>
            <DriverIcon driver={heroDriver} size={16} />
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
        <span className="thread-avatar" style={projectAvatarStyle(project?.name ?? "cw")} aria-hidden="true">
          {projectInitials(project?.name ?? "cw")}
        </span>
        <span className="crumb" title={`${project?.name ?? ""} / ${session.title}`}>
          <span>{project?.name ?? "…"}</span>
          <span className="crumb-sep">/</span>
          <strong>{session.title}</strong>
        </span>
        <GitPanelBar key={session.id} sessionId={session.id} compact />
      </div>
      <Notifications />
      <div className="thread-body">
        <div className="thread-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="thread-inner">
          {historyLoading && messages.length === 0 && (
            <div className="empty">
              <div className="empty-mark"><Sparkles aria-hidden="true" size={22} /></div>
              <div>Loading history…</div>
            </div>
          )}
          {!historyLoading && historyError && messages.length === 0 && session && (
            <div className="empty">
              <div className="empty-mark"><TriangleAlert aria-hidden="true" size={22} /></div>
              <div>Could not load history.</div>
              <div className="notif-msg">{historyError}</div>
              <button
                className="btn btn-primary"
                onClick={() => void ensureHistory(session.id, { force: true, isRetry: true })}
              >
                Retry
              </button>
            </div>
          )}
          {!historyLoading && !historyError && messages.length === 0 && !busyTurn && (
            <div className="empty">
              <div className="empty-mark"><Sparkles aria-hidden="true" size={22} /></div>
              <div>Prompt below to begin.</div>
            </div>
          )}
          {nodes.map((n) => {
            if (n.kind === "sub") {
              return <SubagentCard key={n.key} group={n.group} />;
            }
            if (n.kind === "tools") {
              return (
                <ToolGroupCard
                  key={n.key}
                  messages={n.items}
                  basePath={basePath}
                  sessionId={session.id}
                  onPreview={onOpenPreview}
                />
              );
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
                  basePath={basePath}
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
                  {m.retryable && (
                    <button className="msg-retry" onClick={() => void retryConnection(session.id)}>
                      Retry connection
                    </button>
                  )}
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
          {!atBottom && (
            <div className="jump-bottom-wrap">
              <button className="jump-bottom" onClick={scrollToBottom} title="Scroll to bottom" aria-label="Scroll to bottom">
                <ChevronDown size={14} aria-hidden="true" />
                Scroll to bottom
              </button>
            </div>
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
        <TodoDock sessionId={session.id} />
        <ApprovalDock sessionId={session.id} />
        <QuestionDock sessionId={session.id} />
        <Composer key={session.id} sessionId={session.id} driver={session.driver} />
      </div>
      </div>
    </div>
  );
}
