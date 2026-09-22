import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Sparkles, TriangleAlert } from "lucide-react";
import type { DockableTabId } from "@cw-code/contracts";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";
import { Notifications } from "./Notifications.js";
import { Md, StreamingMd } from "./Markdown.js";
import { BottomPanel } from "./BottomPanel.js";
import { MainTabStrip } from "./MainTabStrip.js";
import { GitPanelBar } from "./GitPanelBar.js";
import { ToolContent } from "./ToolContent.js";
import { useDockDrop } from "./useDockDrop.js";
import { Composer } from "./Composer.js";
import { isBottomOpen, resolveMainTab } from "../stores/panelLayout.js";
import { ToolCard } from "./ToolCard.js";
import { ToolGroupCard } from "./ToolGroupCard.js";
import { ReasoningBlock } from "./ReasoningBlock.js";
import { SubagentCard } from "./SubagentCard.js";
import { NewThread } from "./NewThread.js";
import { ApprovalDock } from "./ApprovalDock.js";
import { QuestionDock } from "./QuestionDock.js";
import { TodoDock } from "./TodoDock.js";
import { TurnBlock } from "./TurnBlock.js";
import { groupTurns, splitTurn, type ThreadNode } from "./turnGroups.js";
import { pendingToolsForTurn } from "./toolSummaries.js";
import { durationFromMessages } from "./turnFormat.js";
import { usePanelStore } from "../stores/panelStore.js";
import { collectSubagents } from "./subagents.js";
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
  const reasoningExpanded = useAppStore((s) => (session ? s.reasoningExpandedByDriver[session.driver] : false));
  const openPreview = useAppStore((s) => s.openPreview);
  const panelActiveMain = usePanelStore((s) => s.activeMain);
  const panelDockByTab = usePanelStore((s) => s.dockByTab);
  const panelMainOrder = usePanelStore((s) => s.mainOrder);
  const dropMain = useDockDrop("main");
  const draggingTab = usePanelStore((s) => s.draggingTab);
  const setPendingDriver = useAppStore((s) => s.setPendingDriver);
  const turnStartedAt = useAppStore((s) => (activeSessionId ? s.turnStartedAt[activeSessionId] : undefined));
  const turnDurations = useAppStore((s) => (activeSessionId ? s.turnDurations[activeSessionId] : undefined));
  const subagents = useMemo(() => collectSubagents(messages), [messages]);
  const nestedIds = useMemo(() => new Set(subagents.map((s) => s.id)), [subagents]);
  const turns = useMemo(
    () =>
      groupTurns(messages).map((slice) => {
        const running = busyTurn === slice.turnId;
        const known = turnDurations?.[slice.turnId];
        return {
          turnId: slice.turnId,
          pieces: splitTurn(slice.messages, nestedIds, running),
          running,
          startedAt: running ? turnStartedAt : undefined,
          pending: running ? pendingToolsForTurn(slice.messages, slice.turnId) : undefined,
          durationMs: known ?? durationFromMessages(slice.messages)
        };
      }),
    [messages, nestedIds, busyTurn, turnStartedAt, turnDurations]
  );
  const streamingId = useMemo(() => {
    if (!busyTurn) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.turnId === busyTurn) return m.id;
    }
    return null;
  }, [messages, busyTurn]);
  const showNew = pendingDriver !== null || !session;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastSeenIdRef = useRef<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const sessionId = session?.id;
  const resolvedMainTab =
    session === undefined
      ? "chat"
      : resolveMainTab(panelMainOrder, panelDockByTab, session.driver, panelActiveMain);
  const showMainTool: DockableTabId | null = resolvedMainTab === "chat" ? null : resolvedMainTab;
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
  }, [messages, busyTurn]);

  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el || !(inner instanceof HTMLElement)) return;
    const stickToBottom = () => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(stickToBottom);
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

  const head = (
    <div className="head-seg main-seg" onDoubleClick={() => window.cw.toggleMaximizeWindow()}>
      <div className="head-col col-left">
        <div className="titlebar-crumb">
          {project && session ? (
            <span title={`${project.name} / ${session.title}`}>
              {project.name} <span className="sep">/</span> <strong>{session.title}</strong>
            </span>
          ) : project && pendingDriver ? (
            <span title={`${project.name} / New thread`}>
              {project.name} <span className="sep">/</span> <strong>New thread</strong>
            </span>
          ) : (
            <span className="titlebar-tagline">Desktop workspace for coding CLIs</span>
          )}
        </div>
      </div>
      <div className="head-col col-mid" />
      <div className="head-col col-right">
        {!showNew && sessionId && <GitPanelBar key={sessionId} sessionId={sessionId} />}
      </div>
    </div>
  );

  if (showNew) {
    const heroDriver = pendingDriver ?? session?.driver ?? lastDriver;
    return (
      <div className="thread-col">
        {head}
        <MainTabStrip sessionId={undefined} driver={heroDriver} />
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

  const renderNode = (n: ThreadNode) => {
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
        <div key={m.id} className={`msg-system${m.severity === "warning" ? " msg-warning" : ""}`}>
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
    if (m.role === "reasoning") {
      return (
        <ReasoningBlock
          key={`${m.id}:${reasoningExpanded ? "open" : "closed"}`}
          message={m}
          live={busyTurn === m.turnId && m.reasoningMs === undefined}
          defaultOpen={reasoningExpanded}
        />
      );
    }
    if (m.id === streamingId) {
      return (
        <div key={m.id} className="msg-assistant">
          <StreamingMd text={m.text} onOpenFile={onOpenPreview} />
        </div>
      );
    }
    return (
      <div key={m.id} className="msg-assistant">
        <Md text={m.text} onOpenFile={onOpenPreview} />
      </div>
    );
  };

  return (
    <div className="thread-col">
      {head}
      <MainTabStrip sessionId={session.id} driver={session.driver} />
      <Notifications />
      {showMainTool !== null ? (
        <div
          className={`main-tool-body${dropMain.over ? " drop-target-active" : ""}`}
          {...dropMain.bind}
        >
          <ToolContent tab={showMainTool} sessionId={session.id} panel="main" />
        </div>
      ) : (
      <div
        className={`thread-body${dropMain.over ? " drop-target-active" : ""}`}
        {...dropMain.bind}
      >
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
          {turns.map((turn, index) => (
            <TurnBlock
              key={`${turn.turnId}:${index}`}
              running={turn.running}
              startedAt={turn.startedAt}
              durationMs={turn.durationMs}
              hasActivity={turn.pieces.activity.length > 0}
              autoExpandIfFits={index === turns.length - 1}
              pending={turn.pending}
              lead={turn.pieces.lead.map((m) => renderNode({ kind: "msg", msg: m }))}
              activity={turn.pieces.activity.map(renderNode)}
              system={turn.pieces.system.map((m) => renderNode({ kind: "msg", msg: m }))}
              pinned={turn.pieces.pinned ? renderNode({ kind: "msg", msg: turn.pieces.pinned }) : undefined}
            />
          ))}
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
      </div>
      )}
      {showMainTool === null && (
      <div className="composer-wrap">
        <TodoDock sessionId={session.id} />
        <ApprovalDock sessionId={session.id} />
        <QuestionDock sessionId={session.id} />
        <Composer key={session.id} sessionId={session.id} driver={session.driver} />
      </div>
      )}
      {(isBottomOpen(panelDockByTab) || draggingTab !== null) && (
        <BottomPanel sessionId={session.id} driver={session.driver} />
      )}
    </div>
  );
}
