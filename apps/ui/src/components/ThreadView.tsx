import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy, Sparkles, TriangleAlert } from "lucide-react";
import type { DockableTabId } from "@cw-code/contracts";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";
import { useNotifs } from "./Notifications.js";
import { ipcErrorMessage } from "./ipcError.js";
import { Md, StreamingMd, resolvePreviewPaths } from "./Markdown.js";
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
import { CwSubagentCard } from "./CwSubagentCard.js";
import { SubagentResultsCard } from "./SubagentResultsCard.js";
import { SubagentRequestDocks } from "./SubagentRequestDocks.js";
import { cwSubagentCardTool, wakeEntriesOf } from "./cwSubagents.js";
import { CompactionNote } from "./CompactionNote.js";
import { NewThread } from "./NewThread.js";
import { ApprovalDock } from "./ApprovalDock.js";
import { QuestionDock } from "./QuestionDock.js";
import { TodoDock } from "./TodoDock.js";
import { BranchMismatchDock } from "./BranchMismatchNotice.js";
import { PrUpdateDock } from "./PrUpdateDock.js";
import { WorkingDock } from "./WorkingDock.js";
import { PrSessionChip } from "./PrSessionPanel.js";
import { useMarkTurnSeen } from "./useTurnSeen.js";
import { sessionLinks } from "./sessionPrLinks.js";
import { TurnBlock } from "./TurnBlock.js";
import { TurnChangesCard } from "./TurnChangesCard.js";
import { snapshotTurnMatches } from "./turnChanges.js";
import { countActivityTools, groupTurns, splitTurn, type ThreadNode } from "./turnGroups.js";
import { pendingToolsForTurn } from "./toolSummaries.js";
import { durationFromMessages } from "./turnFormat.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";
import { collectSubagents } from "./subagents.js";
import { splitImageMentions } from "./imagePreview.js";
import { ImageThumb } from "./ImageThumb.js";
import { ThreadVisibleContext } from "./threadVisibility.js";
import { toolAvailability } from "./toolTabs.js";
import { SkillChip } from "./SkillChip.js";
import { skillSegments } from "./skillSegments.js";
import { findSkillReferences } from "@cw-code/shared/skillMentions";
import { useSessionSkillNames } from "../stores/sessionSkillsStore.js";
import { PromptRail, type PromptMark } from "./PromptRail.js";
import { ThreadFindBar } from "./ThreadFindBar.js";
import { useThreadFind } from "./useThreadFind.js";
import { runningTurnId, useThreadEntry, useThreadItems, useThreadTopicError } from "./useThread.js";

const SKILL_TOKEN_HINT = /(^|\s)[$/][A-Za-z0-9]/;
const FOLLOW_BAND = 64;
const SCROLL_UP_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function pinToBottom(el: HTMLElement): void {
  if (distanceFromBottom(el) > 1) el.scrollTop = el.scrollHeight;
}

function nestedScrollerTakesUpward(target: EventTarget | null, root: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== root; node = node.parentElement) {
    if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) {
      const { overflowY } = getComputedStyle(node);
      if (overflowY === "auto" || overflowY === "scroll") return true;
    }
  }
  return false;
}

function reloadHistory(sessionId: string): void {
  void window.cw.reloadHistory(sessionId).catch((err: unknown) => {
    useNotifs.getState().push({ kind: "error", title: "Could not load history", message: ipcErrorMessage(err) });
  });
}

const UserMessage = memo(function UserMessage({
  message,
  sessionId,
  projectId,
  skills
}: {
  message: ChatMessage;
  sessionId: string;
  projectId: string | undefined;
  skills: ReadonlySet<string>;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(message.text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        useNotifs.getState().push({
          kind: "error",
          title: "Could not copy message",
          message: "Clipboard access failed."
        });
      });
  };

  const date = message.timestamp === undefined ? undefined : new Date(message.timestamp);
  const validDate = date && Number.isFinite(date.getTime()) ? date : undefined;

  return (
    <div className="msg-user-wrap" data-prompt-id={message.id}>
      <div className="msg-user">
        {splitImageMentions(message.text).map((seg, i) =>
          seg.kind === "image" ? (
            <ImageThumb
              key={i}
              target={{ sessionId, projectId }}
              path={seg.path}
              className="msg-image-thumb"
            />
          ) : (
            <span key={i}>
              {skillSegments(seg.value, findSkillReferences(seg.value, skills)).map((part, j) =>
                part.kind === "skill" ? <SkillChip key={j} name={part.name} raw={part.raw} /> : part.value
              )}
            </span>
          )
        )}
      </div>
      <div className="msg-user-meta">
        {validDate && (
          <time dateTime={validDate.toISOString()} title={validDate.toLocaleString()}>
            {validDate.toLocaleString(undefined, {
              month: "numeric",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit"
            })}
          </time>
        )}
        <button
          type="button"
          className="msg-user-copy"
          onClick={copy}
          title={copied ? "Copied" : "Copy message"}
          aria-label="Copy message"
        >
          <span className="msg-user-copy-status" aria-live="polite">
            {copied ? "Copied" : ""}
          </span>
          {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
        </button>
      </div>
    </div>
  );
});

export function ThreadView({ hidden = false }: { hidden?: boolean }) {
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
  const messages = useThreadItems(activeSessionId);
  const wantsSkills = useMemo(
    () => messages.some((m) => m.role === "user" && SKILL_TOKEN_HINT.test(m.text)),
    [messages]
  );
  const skillNames = useSessionSkillNames(activeSessionId ?? "", Boolean(activeSessionId) && wantsSkills);
  const turn = useThreadEntry(activeSessionId, "turn");
  const busyTurn = runningTurnId(turn, messages);
  const hasPreview = useAppStore((s) =>
    activeSessionId ? (s.previewBySession[activeSessionId] ?? null) !== null : false
  );
  const history = useThreadEntry(activeSessionId, "history");
  const topicError = useThreadTopicError(activeSessionId);
  const historyError = history?.state === "error" ? (history.error ?? "unknown error") : (topicError ?? undefined);
  const historyLoading = !historyError && history?.state !== "loaded";
  const hasMessages = messages.length > 0;
  const notifiedHistoryError = useRef<string | null>(null);
  useEffect(() => {
    if (!historyError) {
      notifiedHistoryError.current = null;
      return;
    }
    if (!activeSessionId || !hasMessages) return;
    const key = `${activeSessionId}:${historyError}`;
    if (notifiedHistoryError.current === key) return;
    notifiedHistoryError.current = key;
    useNotifs.getState().push({
      kind: "error",
      title: "Could not load history",
      message: historyError,
      actions: [{ label: "Retry", primary: true, onClick: () => reloadHistory(activeSessionId) }]
    });
  }, [activeSessionId, historyError, hasMessages]);
  const retryConnection = useAppStore((s) => s.retryConnection);
  const reasoningExpanded = useAppStore((s) => (session ? s.reasoningExpandedByDriver[session.driver] : false));
  const openPreview = useAppStore((s) => s.openPreview);
  const {
    activeMain: panelActiveMain,
    dockByTab: panelDockByTab,
    mainOrder: panelMainOrder
  } = usePanelStore((s) => selectSessionPanel(s, activeSessionId ?? undefined));
  const activateOrOpen = usePanelStore((s) => s.activateOrOpen);
  const setRightVisible = usePanelStore((s) => s.setRightVisible);
  const dropMain = useDockDrop("main", activeSessionId ?? undefined);
  const draggingTab = usePanelStore((s) => s.draggingTab);
  const setPendingDriver = useAppStore((s) => s.setPendingDriver);
  const turnStartedAt = turn?.startedAt;
  const turnDurations = useThreadEntry(activeSessionId, "durations");
  const sessionDriver = session?.driver;
  const subagents = useMemo(() => collectSubagents(messages), [messages]);
  const nestedIds = useMemo(() => new Set(subagents.map((s) => s.id)), [subagents]);
  const turns = useMemo(
    () =>
      groupTurns(messages).map((slice) => {
        const running = busyTurn === slice.turnId;
        const known = turnDurations?.[slice.turnId];
        const first = slice.messages[0];
        return {
          key: slice.messages[0].seq,
          turnId: slice.turnId,
          pieces: splitTurn(slice.messages, nestedIds, running, sessionDriver),
          running,
          promptedAt: first?.role === "user" ? first.timestamp : undefined,
          startedAt: running ? turnStartedAt : undefined,
          pending: running ? pendingToolsForTurn(slice.messages, slice.turnId) : undefined,
          durationMs: known ?? durationFromMessages(slice.messages)
        };
      }),
    [messages, nestedIds, busyTurn, turnStartedAt, turnDurations, sessionDriver]
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
  const hasPr = !showNew && sessionLinks(session).length > 0;
  useMarkTurnSeen(showNew ? undefined : session?.id, session?.status, !hidden);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastSeenIdRef = useRef<string | null>(null);
  const hiddenRef = useRef(hidden);
  const savedScrollTopRef = useRef(0);
  const lastDistanceRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  const promptMarks = useMemo<PromptMark[]>(
    () => messages.filter((m) => m.role === "user").map((m) => ({ id: m.id, text: wakeEntriesOf(m) ? "Subagent results" : m.text })),
    [messages]
  );

  const sessionId = session?.id;
  const turnSnapshot = session?.lastTurnSnapshot;
  const changesTurnIndex = snapshotTurnMatches(turns[turns.length - 1], turnSnapshot) ? turns.length - 1 : -1;
  const isToolAvailable = toolAvailability(session?.driver, hasPr, hasPreview);
  const resolvedMainTab =
    session === undefined
      ? "chat"
      : resolveMainTab(panelMainOrder, panelDockByTab, session.driver, panelActiveMain, hasPr, isToolAvailable);
  const showMainTool: DockableTabId | null = resolvedMainTab === "chat" ? null : resolvedMainTab;
  const threadMounted = !showNew;
  const threadHidden = hidden || showMainTool !== null;
  hiddenRef.current = threadHidden;
  const find = useThreadFind({
    scrollRef,
    contentRef: innerRef,
    enabled: threadMounted && !threadHidden,
    revision: messages
  });
  const basePath = session?.worktreePath ?? project?.rootPath ?? "";
  const onOpenPreview = useCallback(
    (path: string) => {
      if (!sessionId) return;
      openPreview(sessionId, path, basePath);
      activateOrOpen(sessionId, "preview");
      setRightVisible(sessionId, true);
    },
    [openPreview, sessionId, basePath, activateOrOpen, setRightVisible]
  );
  const onOpenSource = useCallback(
    (path: string, line?: number) => {
      if (!sessionId) return;
      usePanelStore.getState().revealFile(sessionId, resolvePreviewPaths(basePath, path).rel, line);
    },
    [sessionId, basePath]
  );
  const local = window.cw.local;
  const openExternalLocally = useCallback(
    (path: string) => {
      if (!local) return;
      const { abs } = resolvePreviewPaths(basePath, path);
      void local.openPath(abs).catch((err: Error) => {
        useNotifs.getState().push({ kind: "error", title: "Could not open file", message: err.message });
      });
    },
    [basePath, local]
  );
  const onOpenExternal = local ? openExternalLocally : undefined;

  useEffect(() => {
    stickRef.current = true;
    lastSeenIdRef.current = null;
    savedScrollTopRef.current = 0;
    lastDistanceRef.current = 0;
    setAtBottom(true);
  }, [activeSessionId]);

  useLayoutEffect(() => {
    if (threadHidden) return;
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) pinToBottom(el);
    else el.scrollTop = savedScrollTopRef.current;
  }, [threadHidden, threadMounted]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last && last.id !== lastSeenIdRef.current) {
      lastSeenIdRef.current = last.id;
      if (last.role === "user") stickRef.current = true;
    }
    if (threadHidden) return;
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && stickRef.current) pinToBottom(el);
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, busyTurn, threadHidden]);

  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!threadMounted || !el || !(inner instanceof HTMLElement)) return;
    let pressedInside = false;
    const release = () => {
      if (hiddenRef.current || !stickRef.current) return;
      stickRef.current = false;
      lastDistanceRef.current = distanceFromBottom(el);
      setAtBottom(false);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && !e.ctrlKey && el.scrollTop > 0 && !nestedScrollerTakesUpward(e.target, el)) release();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === el && e.offsetX >= el.clientWidth && el.scrollHeight > el.clientHeight) release();
    };
    const onTouchMove = () => {
      if (distanceFromBottom(el) >= FOLLOW_BAND) release();
    };
    const trackPress = (e: PointerEvent) => {
      pressedInside = e.target instanceof Node && el.contains(e.target);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!SCROLL_UP_KEYS.has(e.key) || e.defaultPrevented || e.isComposing) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target;
      const focusInside = target instanceof Node && el.contains(target);
      const focusOnPage = target === document.body || target === document.documentElement;
      if (!focusInside && !(focusOnPage && pressedInside)) return;
      if (el.scrollTop > 0 && !nestedScrollerTakesUpward(target, el)) release();
    };
    const ro = new ResizeObserver(() => {
      if (!hiddenRef.current && stickRef.current) pinToBottom(el);
    });
    ro.observe(inner);
    ro.observe(el);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("pointerdown", trackPress, { capture: true, passive: true });
    document.addEventListener("keydown", onKeyDown, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("pointerdown", trackPress, { capture: true });
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeSessionId, threadMounted]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const wrap = composerWrapRef.current;
    if (!threadMounted || !stage || !wrap) return;
    const sync = () => {
      if (wrap.getClientRects().length === 0) return;
      stage.style.setProperty("--composer-overlay-h", `${Math.ceil(wrap.getBoundingClientRect().height)}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [activeSessionId, threadMounted]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || hiddenRef.current) return;
    savedScrollTopRef.current = el.scrollTop;
    const distance = distanceFromBottom(el);
    const previous = lastDistanceRef.current;
    lastDistanceRef.current = distance;
    if (distance >= FOLLOW_BAND) {
      stickRef.current = false;
      setAtBottom(false);
    } else if (distance < previous) {
      stickRef.current = true;
      setAtBottom(true);
    }
  };

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }, []);

  const frame = (children: ReactNode) => (
    <ThreadVisibleContext.Provider value={!hidden}>
      <div className="thread-col" hidden={hidden} style={hidden ? { display: "none" } : undefined}>
        {children}
      </div>
    </ThreadVisibleContext.Provider>
  );

  const head = (
    <div className="head-seg main-seg" onDoubleClick={() => window.cw.shell?.toggleMaximizeWindow()}>
      <div className="head-col col-left">
        <div className="titlebar-crumb">
          {project && session ? (
            <span title={`${project.name} / ${session.title}`}>
              {project.name} <span className="sep">/</span> <strong>{session.title}</strong>
            </span>
          ) : project && pendingDriver ? (
            <span title={`${project.name} / New session`}>
              {project.name} <span className="sep">/</span> <strong>New session</strong>
            </span>
          ) : (
            <span className="titlebar-tagline">Desktop workspace for coding CLIs</span>
          )}
        </div>
      </div>
      <div className="head-col col-mid" />
      <div className="head-col col-right">
        {!showNew && sessionId && <GitPanelBar key={`git:${sessionId}`} sessionId={sessionId} />}
        {!showNew && sessionId && <PrSessionChip key={`pr:${sessionId}`} sessionId={sessionId} />}
      </div>
    </div>
  );

  if (showNew) {
    const heroDriver = pendingDriver ?? session?.driver ?? lastDriver;
    return frame(
      <>
        {head}
        <MainTabStrip sessionId={undefined} driver={heroDriver} hasPr={false} />
        <NewThread
          key={activeProjectId}
          projectId={activeProjectId}
          driver={heroDriver}
          onDriverChange={setPendingDriver}
        />
      </>
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
          sessionDriver={session.driver}
          onPreview={onOpenPreview}
        />
      );
    }
    const m = n.msg;
    if (m.role === "user") {
      const wake = wakeEntriesOf(m);
      if (wake) return <SubagentResultsCard key={m.id} message={m} entries={wake} />;
      return <UserMessage key={m.id} message={m} sessionId={session.id} projectId={project?.id} skills={skillNames} />;
    }
    if (m.role === "tool" && cwSubagentCardTool(m.toolName, session.driver)) {
      return <CwSubagentCard key={m.id} message={m} sessionId={session.id} sessionDriver={session.driver} />;
    }
    if (m.role === "tool") {
      return (
        <ToolCard
          key={m.id}
          message={m}
          basePath={basePath}
          sessionId={session.id}
          sessionDriver={session.driver}
          onPreview={onOpenPreview}
        />
      );
    }
    if (m.role === "system") {
      if (m.compaction) {
        return <CompactionNote key={m.id} message={m} />;
      }
      return (
        <div key={m.id} className={`msg-system${m.severity === "warning" ? " msg-warning" : ""}`}>
          <TriangleAlert size={14} aria-hidden="true" />
          <span>{m.text}</span>
          {m.retryable && session.status !== "resolved" && session.status !== "archived" && (
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
          <StreamingMd
            text={m.text}
            onOpenFile={onOpenPreview}
            onOpenSource={onOpenSource}
            onOpenExternal={onOpenExternal}
          />
        </div>
      );
    }
    return (
      <div key={m.id} className="msg-assistant">
        <Md
          text={m.text}
          onOpenFile={onOpenPreview}
          onOpenSource={onOpenSource}
          onOpenExternal={onOpenExternal}
        />
      </div>
    );
  };

  const renderPinnedAnswer = (pinned: ChatMessage[]): ReactNode[] => {
    let primary = 0;
    for (let i = 1; i < pinned.length; i++) {
      if (pinned[i].text.length > pinned[primary].text.length) primary = i;
    }
    return pinned.map((m, i) =>
      i === primary ? (
        renderNode({ kind: "msg", msg: m })
      ) : (
        <div className="turn-pinned-cont" key={m.id}>
          {renderNode({ kind: "msg", msg: m })}
        </div>
      )
    );
  };

  return frame(
    <>
      {head}
      <MainTabStrip sessionId={session.id} driver={session.driver} hasPr={hasPr} />
      {showMainTool !== null && (
        <div
          className={`main-tool-body${dropMain.over ? " drop-target-active" : ""}`}
          {...dropMain.bind}
        >
          <ToolContent tab={showMainTool} sessionId={session.id} panel="main" />
        </div>
      )}
      <ThreadVisibleContext.Provider value={!threadHidden}>
      <div
        className="thread-stage"
        ref={stageRef}
        hidden={showMainTool !== null}
        style={showMainTool !== null ? { display: "none" } : undefined}
      >
      <div
        className={`thread-body${dropMain.over ? " drop-target-active" : ""}`}
        {...dropMain.bind}
      >
        <div className="thread-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="thread-inner" ref={innerRef}>
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
                onClick={() => reloadHistory(session.id)}
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
              key={turn.key}
              running={turn.running}
              startedAt={turn.startedAt}
              durationMs={turn.durationMs}
              hasActivity={turn.pieces.activity.length > 0}
              autoExpandIfFits={index === turns.length - 1}
              pending={turn.pending}
              toolCount={countActivityTools(turn.pieces.activity)}
              lead={turn.pieces.lead.map((m) => renderNode({ kind: "msg", msg: m }))}
              activity={turn.pieces.activity.map(renderNode)}
              system={turn.pieces.system.map((m) => renderNode({ kind: "msg", msg: m }))}
              pinned={renderPinnedAnswer(turn.pieces.pinned ?? [])}
              footer={
                index === changesTurnIndex && turnSnapshot ? (
                  <TurnChangesCard key={turnSnapshot.turnId} sessionId={session.id} snapshot={turnSnapshot} />
                ) : undefined
              }
            />
          ))}
          <div className="thread-composer-spacer" aria-hidden="true" />
          </div>
        </div>
      </div>
      <PromptRail
        scrollRef={scrollRef}
        prompts={promptMarks}
        matches={find.ranges}
        activeRange={find.activeRange}
        revision={messages}
      />
      <ThreadFindBar find={find} />
      {!atBottom && (
        <button className="jump-bottom" onClick={scrollToBottom} title="Scroll to bottom" aria-label="Scroll to bottom">
          <ChevronDown size={14} aria-hidden="true" />
          Scroll to bottom
        </button>
      )}
      <div className="composer-wrap" ref={composerWrapRef}>
        <Composer
          key={`composer:${session.id}`}
          sessionId={session.id}
          driver={session.driver}
          top={
            <>
              <TodoDock sessionId={session.id} />
              <BranchMismatchDock key={`branch-dock:${session.id}`} sessionId={session.id} />
              <PrUpdateDock key={`pr-dock:${session.id}`} sessionId={session.id} />
              <ApprovalDock sessionId={session.id} />
              <QuestionDock sessionId={session.id} />
              {!threadHidden && <SubagentRequestDocks sessionId={session.id} />}
              <WorkingDock key={`working-dock:${session.id}`} sessionId={session.id} sessionDriver={session.driver} basePath={basePath} />
            </>
          }
        />
      </div>
      </div>
      </ThreadVisibleContext.Provider>
      {(isBottomOpen(panelDockByTab, isToolAvailable) || draggingTab !== null) && (
        <BottomPanel sessionId={session.id} />
      )}
    </>
  );
}
