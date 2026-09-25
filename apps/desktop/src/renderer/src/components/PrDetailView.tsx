import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Eye,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  Lock,
  MessageSquare,
  RefreshCw,
  Sparkles,
  Wrench,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PrWorkflowIcon } from "@cw-code/contracts";
import type { PrCheck, PrDetail, PrRef, PrReviewThread, PrTimelineItem, PrWorkflow, Session } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";
import { usePrStore, type PrDetailTab } from "../stores/prStore.js";
import { PanelToggles } from "./PanelToggles.js";
import { DriverIcon } from "./DriverIcon.js";
import { Md } from "./Markdown.js";
import { useNotifs } from "./Notifications.js";
import { PrFilesPanel } from "./PrFilesPanel.js";
import { prKey } from "./prInbox.js";
import { firstUnseenIndex } from "./prUpdates.js";
import { usePrSettings } from "./useLinkedPr.js";
import { suggestedWorkflow } from "./prWorkflows.js";
import { linkedSessionsBarState, mergeBoxState, threadQuoteText, threadSendTarget, type LinkedBarState } from "./prDetailModel.js";
import { linkFor, pickMainSession, sessionsLinkedTo } from "./sessionPrLinks.js";

const WORKFLOW_ICONS: Record<PrWorkflowIcon, LucideIcon> = {
  eye: Eye,
  activity: Activity,
  message: MessageSquare,
  wrench: Wrench,
  merge: GitMerge,
  bot: Bot,
  sparkle: Sparkles
};

const MAX_LOG_LINES = 2000;

function workflowIcon(icon: PrWorkflowIcon): LucideIcon {
  return WORKFLOW_ICONS[icon] ?? Sparkles;
}

function openExternalLink(url: string): void {
  void window.cw.openExternal(url).catch(() => {
    useNotifs.getState().push({ kind: "error", title: "Could not open link", message: url });
  });
}

function ageLabel(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function without<T>(record: Record<number, T>, key: number): Record<number, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

const TABS: Array<{ id: PrDetailTab; label: string }> = [
  { id: "conversation", label: "Conversation" },
  { id: "commits", label: "Commits" },
  { id: "checks", label: "Checks" },
  { id: "files", label: "Files changed" }
];

function reviewVerb(state: Extract<PrTimelineItem, { kind: "review" }>["state"]): string {
  switch (state) {
    case "APPROVED":
      return "approved these changes";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed their review";
  }
}

function eventVerb(kind: Extract<PrTimelineItem, { kind: "merged" | "closed" | "reopened" | "ready_for_review" }>["kind"]): string {
  switch (kind) {
    case "merged":
      return "merged this pull request";
    case "closed":
      return "closed this pull request";
    case "reopened":
      return "reopened this pull request";
    case "ready_for_review":
      return "marked this ready for review";
  }
}

function HunkLines({ hunk }: { hunk: string }) {
  return (
    <div className="pr-detail-hunk">
      {hunk.split("\n").map((line, index) => {
        const cls = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
        return (
          <div key={index} className={`pr-detail-hunk-line ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

function ThreadCard({
  thread,
  onSendToSession
}: {
  thread: PrReviewThread;
  onSendToSession: (thread: PrReviewThread) => void;
}) {
  return (
    <div className="pr-detail-thread">
      <div className="pr-detail-thread-head">
        <span>{thread.path}{thread.line !== null ? `:${thread.line}` : ""}</span>
        <span className="grow" />
        <span className={`pr-detail-thread-state${thread.isResolved ? " resolved" : ""}`}>
          {thread.isResolved ? "Resolved" : "Unresolved"}
        </span>
      </div>
      {thread.diffHunk && <HunkLines hunk={thread.diffHunk} />}
      {thread.comments.map((comment, index) => (
        <div className="pr-detail-thread-comment" key={index}>
          <div className="pr-detail-thread-comment-who"><strong>{comment.author}</strong></div>
          <Md text={comment.body} allowImages={false} />
        </div>
      ))}
      <div className="pr-detail-thread-footer">
        <span className="grow">Reply and resolve on GitHub</span>
        <button className="pr-detail-btn ghost" onClick={() => onSendToSession(thread)}>
          Send to session
        </button>
      </div>
    </div>
  );
}

export function PrDetailView({ prRef }: { prRef: PrRef }) {
  const key = prKey(prRef);
  const detail = usePrStore((s) => s.detailByKey[key]);
  const loading = usePrStore((s) => s.detailLoadingByKey[key] ?? false);
  const error = usePrStore((s) => s.detailErrorByKey[key]);
  const activeTab = usePrStore((s) => (s.mainView.kind === "pr" ? s.mainView.tab : "conversation"));
  const openInbox = usePrStore((s) => s.openInbox);
  const setPrTab = usePrStore((s) => s.setPrTab);
  const loadDetail = usePrStore((s) => s.loadDetail);
  const loadDiff = usePrStore((s) => s.loadDiff);
  const openRunModal = usePrStore((s) => s.openRunModal);
  const openSessionView = usePrStore((s) => s.openSessionView);
  const activeSessionId = useAppStore((s) => s.activeSessionId) ?? undefined;
  const rightVisible = usePanelStore((s) => selectSessionPanel(s, activeSessionId).rightVisible);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const selectSession = useAppStore((s) => s.selectSession);
  const { settings, error: settingsError } = usePrSettings();
  const workflows = useMemo<PrWorkflow[]>(() => settings?.prWorkflows ?? [], [settings]);
  const [selectedCheckIndex, setSelectedCheckIndex] = useState<number | null>(null);
  const [logByRunId, setLogByRunId] = useState<Record<number, string>>({});
  const [logLoadingRunId, setLogLoadingRunId] = useState<number | null>(null);
  const [logErrorByRunId, setLogErrorByRunId] = useState<Record<number, string>>({});
  const [expandedLogRunId, setExpandedLogRunId] = useState<number | null>(null);
  const lastHeadRef = useRef<string | null>(null);

  const allSessions = useMemo(() => Object.values(sessionsByProject).flat(), [sessionsByProject]);
  const linkedSessions = useMemo(() => sessionsLinkedTo(allSessions, prRef), [allSessions, key]);

  const barState: LinkedBarState = detail ? linkedSessionsBarState(detail, linkedSessions, workflows) : { kind: "none" };
  const mainSession = useMemo(() => pickMainSession(linkedSessions, prRef), [linkedSessions, key]);
  const mainLink = mainSession ? linkFor(mainSession, prRef) : undefined;
  const suggested = detail ? suggestedWorkflow(detail, workflows) : null;
  const fixCiWorkflow = workflows.find((w) => w.id === "fix-ci" && w.enabled) ?? suggested;

  useEffect(() => {
    if (!detail) return;
    if (lastHeadRef.current !== null && lastHeadRef.current !== detail.headRefOid) {
      void loadDiff(prRef, true);
    }
    lastHeadRef.current = detail.headRefOid;
  }, [detail?.headRefOid, prRef, loadDiff]);

  const refresh = () => {
    void loadDetail(prRef);
    void loadDiff(prRef, true);
  };

  const openWorkflow = (workflowId: string, continueSessionId?: string) => {
    openRunModal({ workflowId, ref: prRef, continueSessionId });
  };

  const openSession = (sessionId: string) => {
    selectSession(sessionId);
    openSessionView();
  };

  const sendThreadToSession = (thread: PrReviewThread) => {
    const target = threadSendTarget(mainSession, prRef, suggested);
    openRunModal({ ...target, ref: prRef, promptOverride: threadQuoteText(thread, prRef) });
  };

  const onFixCi = fixCiWorkflow ? () => openWorkflow(fixCiWorkflow.id, mainSession?.id) : null;

  const checksActive = activeTab === "checks";

  useEffect(() => {
    if (!detail || !checksActive) return;
    if (selectedCheckIndex !== null) return;
    const firstFailing = detail.checkRuns.findIndex((c) => c.status === "failure");
    if (firstFailing >= 0) setSelectedCheckIndex(firstFailing);
    else if (detail.checkRuns.length > 0) setSelectedCheckIndex(0);
  }, [detail, selectedCheckIndex, checksActive]);

  const selectedCheck = detail && selectedCheckIndex !== null ? (detail.checkRuns[selectedCheckIndex] ?? null) : null;

  useEffect(() => {
    if (!checksActive) return;
    if (!selectedCheck || selectedCheck.status !== "failure" || selectedCheck.runId === null) return;
    const runId = selectedCheck.runId;
    if (logByRunId[runId] !== undefined || logLoadingRunId === runId || logErrorByRunId[runId] !== undefined) return;
    setLogLoadingRunId(runId);
    window.cw.getPrCheckLog(prRef, runId).then((log) => {
      setLogByRunId((prev) => ({ ...prev, [runId]: log }));
    }).catch((err: Error) => {
      setLogErrorByRunId((prev) => ({ ...prev, [runId]: err.message }));
    }).finally(() => {
      setLogLoadingRunId((current) => (current === runId ? null : current));
    });
  }, [checksActive, selectedCheck, prRef, logByRunId, logLoadingRunId, logErrorByRunId]);

  const retryCheckLog = (runId: number) => {
    setLogErrorByRunId((prev) => without(prev, runId));
  };

  const onRetryLog = () => {
    if (selectedCheck && selectedCheck.runId !== null) retryCheckLog(selectedCheck.runId);
  };

  const checkLogRunId = selectedCheck && selectedCheck.status === "failure" ? selectedCheck.runId : null;
  const checkLog = checkLogRunId !== null ? logByRunId[checkLogRunId] : undefined;
  const checkLogLoading = checkLogRunId !== null && logLoadingRunId === checkLogRunId;
  const checkLogError = checkLogRunId !== null ? logErrorByRunId[checkLogRunId] : undefined;

  const checkGroups = useMemo((): Array<[string, Array<{ check: PrCheck; index: number }>]> => {
    if (!detail) return [];
    const groups = new Map<string, Array<{ check: PrCheck; index: number }>>();
    detail.checkRuns.forEach((check, index) => {
      const groupKey = check.workflow ?? "external";
      const list = groups.get(groupKey) ?? [];
      list.push({ check, index });
      groups.set(groupKey, list);
    });
    return Array.from(groups.entries());
  }, [detail]);

  const newSinceIndex = detail && mainLink ? firstUnseenIndex(detail.timeline, mainLink.lastSeenAt) : -1;

  return (
    <div className="thread-col pr-view">
      <div className="head-seg main-seg" onDoubleClick={() => window.cw.toggleMaximizeWindow()}>
        <div className="head-col col-left">
          <nav className="pr-detail-crumbs" aria-label="Breadcrumb">
            <button className="pr-detail-crumb-link" onClick={openInbox}>Pull requests</button>
            <ChevronRight size={12} aria-hidden="true" />
            <span>{prRef.owner}/{prRef.repo}</span>
            <ChevronRight size={12} aria-hidden="true" />
            <strong>#{prRef.number}</strong>
          </nav>
        </div>
        <div className="head-col col-mid" />
        <div className="head-col col-right">
          <button
            className="icon-btn"
            onClick={refresh}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          {detail && (
            <button className="pr-detail-btn ghost" onClick={() => openExternalLink(detail.url)}>
              <ExternalLink size={13} aria-hidden="true" />
              GitHub
            </button>
          )}
          {!rightVisible && <PanelToggles sessionId={activeSessionId} />}
        </div>
      </div>
      <div className="pr-view-body">
        {error && (
          <div className="pr-view-error" role="alert">
            {error}
            <button className="pr-view-retry" onClick={() => void loadDetail(prRef)}>Retry</button>
          </div>
        )}
        {settingsError && (
          <div className="pr-view-error" role="alert">
            Could not load workflows: {settingsError}
          </div>
        )}
        {loading && !detail && <div className="pr-view-empty">Loading pull request…</div>}
        {detail && (
          <div className="pr-detail-wrap">
            <div className="pr-detail-title-row">
              <h1 className="pr-detail-title">
                {detail.title} <span className="num">#{detail.ref.number}</span>
              </h1>
            </div>
            <div className="pr-detail-sub">
              <span className={`pr-detail-pill ${detail.state === "MERGED" ? "merged" : detail.state === "CLOSED" ? "closed" : detail.isDraft ? "draft" : "open"}`}>
                {detail.state === "MERGED" ? "Merged" : detail.state === "CLOSED" ? "Closed" : detail.isDraft ? "Draft" : "Open"}
              </span>
              <span>
                <strong>{detail.viewerIsAuthor ? "You" : detail.author.login}</strong> {detail.viewerIsAuthor ? "want" : "wants"} to merge into{" "}
                <code>{detail.baseRefName}</code> from <code>{detail.headRefName}</code>
              </span>
            </div>

            <LinkedSessionsBar
              barState={barState}
              mainSession={mainSession}
              onOpenSession={openSession}
              onRunWorkflow={openWorkflow}
            />

            <div className="pr-detail-tabs">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  className={`pr-detail-tab${activeTab === tab.id ? " active" : ""}`}
                  onClick={() => setPrTab(tab.id)}
                >
                  {tab.label}
                  {tab.id === "commits" && <span className="pr-detail-tab-count">{detail.commits.length}</span>}
                  {tab.id === "checks" && <span className="pr-detail-tab-count">{detail.checkRuns.length}</span>}
                  {tab.id === "files" && <span className="pr-detail-tab-count">{detail.changedFiles}</span>}
                </button>
              ))}
              <span className="grow" />
              <span className="pr-detail-tabs-stat">
                <span className="add">+{detail.additions}</span> <span className="del">−{detail.deletions}</span>
              </span>
            </div>

            <div className="pr-detail-cols">
              <div className="pr-detail-main">
                {activeTab === "conversation" && (
                  <ConversationTab
                    detail={detail}
                    newSinceIndex={newSinceIndex}
                    sessionTitle={mainSession?.title ?? null}
                    onSendThread={sendThreadToSession}
                    onGoToChecks={() => setPrTab("checks")}
                  />
                )}
                {activeTab === "commits" && <CommitsTab detail={detail} />}
                {activeTab === "checks" && (
                  <ChecksTab
                    checkGroups={checkGroups}
                    selectedIndex={selectedCheckIndex}
                    selectedCheck={selectedCheck}
                    onSelectCheck={setSelectedCheckIndex}
                    log={checkLog}
                    logLoading={checkLogLoading}
                    logError={checkLogError}
                    onRetryLog={onRetryLog}
                    expandedLogRunId={expandedLogRunId}
                    onExpandLog={setExpandedLogRunId}
                    onFixCi={onFixCi}
                  />
                )}
                {activeTab === "files" && <PrFilesPanel prRef={prRef} />}
              </div>

              <SideColumn
                detail={detail}
                linkedSessions={linkedSessions}
                workflows={workflows}
                suggested={suggested}
                onOpenSession={openSession}
                onRunWorkflow={openWorkflow}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LinkedSessionsBar({
  barState,
  mainSession,
  onOpenSession,
  onRunWorkflow
}: {
  barState: LinkedBarState;
  mainSession: Session | null;
  onOpenSession: (sessionId: string) => void;
  onRunWorkflow: (workflowId: string, continueSessionId?: string) => void;
}) {
  if (barState.kind === "continue") {
    return (
      <div className="pr-detail-linkbar">
        <DriverIcon driver={barState.session.driver} size={13} />
        <span className="pr-detail-linkbar-text">
          Your review session <strong>{barState.session.title}</strong> is behind the current head.
        </span>
        <button className="pr-detail-btn" onClick={() => onOpenSession(barState.session.id)}>Open session</button>
        <button className="pr-detail-btn primary" onClick={() => onRunWorkflow(barState.workflowId, barState.session.id)}>
          <RefreshCw size={13} aria-hidden="true" />
          Re-review changes
        </button>
      </div>
    );
  }
  if (barState.kind === "open") {
    const suggested = barState.suggested;
    return (
      <div className="pr-detail-linkbar">
        <DriverIcon driver={barState.session.driver} size={13} />
        <span className="pr-detail-linkbar-text">
          Linked to <strong>{barState.session.title}</strong>.
        </span>
        <button className="pr-detail-btn primary" onClick={() => onOpenSession(barState.session.id)}>Open session</button>
        {suggested && (
          <button className="pr-detail-btn" onClick={() => onRunWorkflow(suggested.id)}>
            {suggested.label}
          </button>
        )}
      </div>
    );
  }
  if (barState.kind === "run") {
    return (
      <div className="pr-detail-linkbar empty">
        <span className="pr-detail-linkbar-text">No cw-code session is linked to this pull request.</span>
        <button className="pr-detail-btn primary" onClick={() => onRunWorkflow(barState.workflowId)}>Run workflow</button>
      </div>
    );
  }
  if (mainSession) {
    return (
      <div className="pr-detail-linkbar">
        <DriverIcon driver={mainSession.driver} size={13} />
        <span className="pr-detail-linkbar-text">
          Linked to <strong>{mainSession.title}</strong>.
        </span>
        <button className="pr-detail-btn" onClick={() => onOpenSession(mainSession.id)}>Open session</button>
      </div>
    );
  }
  return (
    <div className="pr-detail-linkbar empty">
      <span className="pr-detail-linkbar-text">No cw-code session is linked to this pull request.</span>
    </div>
  );
}

function ConversationTab({
  detail,
  newSinceIndex,
  sessionTitle,
  onSendThread,
  onGoToChecks
}: {
  detail: PrDetail;
  newSinceIndex: number;
  sessionTitle: string | null;
  onSendThread: (thread: PrReviewThread) => void;
  onGoToChecks: () => void;
}) {
  const box = mergeBoxState(detail);
  const lastCommitsIndex = detail.timeline.reduce((acc, item, i) => (item.kind === "commits" ? i : acc), -1);
  return (
    <div>
      {detail.body && (
        <div className="pr-detail-comment">
          <div className="pr-detail-comment-head">
            <strong>{detail.viewerIsAuthor ? "you" : detail.author.login}</strong> opened this
          </div>
          <Md text={detail.body} allowImages={false} />
        </div>
      )}
      <div className="pr-detail-timeline">
        {detail.timeline.map((item, index) => (
          <div key={index}>
            {index === newSinceIndex && (
              <div className="pr-detail-since-divider">New since {sessionTitle ? `"${sessionTitle}" last ran` : "last seen"}</div>
            )}
            <TimelineEvent
              item={item}
              detail={detail}
              isLastCommitsEvent={item.kind === "commits" && index === lastCommitsIndex}
              onSendThread={onSendThread}
              onGoToChecks={onGoToChecks}
            />
          </div>
        ))}
      </div>

      <div className="pr-detail-mergebox">
        <span className={`pr-detail-mergebox-icon${box.overallOk ? " ok" : " bad"}`}>
          <GitMerge size={18} aria-hidden="true" />
        </span>
        <div className="pr-detail-mergebox-body">
          <MergeRowView row={box.review} icon={box.review.ok ? Check : MessageSquare} />
          <MergeRowView row={box.ci} icon={box.ci.ok ? Check : X} />
          <MergeRowView row={box.conflicts} icon={box.conflicts.ok ? Check : AlertTriangle} />
          <div className="pr-detail-mergebox-foot">
            <span className="pr-detail-mergebox-lock"><Lock size={12} aria-hidden="true" /> Merging happens on GitHub</span>
            <span className="grow" />
            <button className="pr-detail-btn" onClick={() => openExternalLink(detail.url)}>
              <ExternalLink size={13} aria-hidden="true" />
              Open merge on GitHub
            </button>
          </div>
        </div>
      </div>

      <div className="pr-detail-readonly-note">
        <Lock size={13} aria-hidden="true" />
        <span className="grow">Commenting, reviewing, and approving happen on GitHub in this version.</span>
        <button className="pr-detail-btn" onClick={() => openExternalLink(detail.url)}>
          <ExternalLink size={13} aria-hidden="true" />
          Comment on GitHub
        </button>
      </div>
    </div>
  );
}

function MergeRowView({ row, icon: Icon }: { row: { ok: boolean; label: string; detail: string }; icon: LucideIcon }) {
  return (
    <div className="pr-detail-mergebox-row">
      <span className={`pr-detail-mergebox-row-icon${row.ok ? " ok" : " bad"}`}>
        <Icon size={14} aria-hidden="true" />
      </span>
      <div className="pr-detail-mergebox-row-text">
        <strong>{row.label}</strong>
        {row.detail && <span>{row.detail}</span>}
      </div>
    </div>
  );
}

function TimelineEvent({
  item,
  detail,
  isLastCommitsEvent,
  onSendThread,
  onGoToChecks
}: {
  item: PrTimelineItem;
  detail: PrDetail;
  isLastCommitsEvent: boolean;
  onSendThread: (thread: PrReviewThread) => void;
  onGoToChecks: () => void;
}) {
  const failedSinceThis = isLastCommitsEvent && detail.ci === "failing" ? detail.checkRuns.filter((c) => c.status === "failure") : [];
  if (item.kind === "commits") {
    return (
      <div>
        <div className="pr-detail-event">
          <span className="pr-detail-event-dot"><GitCommitHorizontal size={13} aria-hidden="true" /></span>
          <span><strong>{item.actor}</strong> pushed {item.commits.length} {item.commits.length === 1 ? "commit" : "commits"} · {ageLabel(item.at)} ago</span>
        </div>
        <div className="pr-detail-commits">
          {item.commits.map((commit) => (
            <div className="pr-detail-commit-row" key={commit.oid}>
              {commit.ci === "failing" ? <X size={12} className="bad" aria-hidden="true" /> : commit.ci === "passing" ? <Check size={12} className="ok" aria-hidden="true" /> : null}
              <span>{commit.headline}</span>
              <span className="grow" />
              <span className="pr-detail-commit-sha">{shortSha(commit.oid)}</span>
            </div>
          ))}
        </div>
        {failedSinceThis.length > 0 && (
          <div className="pr-detail-event">
            <span className="pr-detail-event-dot bad"><X size={13} aria-hidden="true" /></span>
            <span>{failedSinceThis.map((c) => c.name).join(", ")} failed</span>
            <button className="pr-detail-btn ghost sm" onClick={onGoToChecks}>View log</button>
          </div>
        )}
      </div>
    );
  }
  if (item.kind === "review") {
    const threads = detail.threads.filter((t) => item.threadIds.includes(t.id));
    const tone = item.state === "APPROVED" ? "ok" : item.state === "CHANGES_REQUESTED" ? "bad" : "info";
    return (
      <div className="pr-detail-comment">
        <div className="pr-detail-comment-head">
          <strong>{item.actor}</strong> {reviewVerb(item.state)} · {ageLabel(item.at)} ago
          <span className={`pr-detail-pill sm ${tone}`}>{item.state.replace("_", " ").toLowerCase()}</span>
        </div>
        {item.body && <Md text={item.body} allowImages={false} />}
        {threads.map((thread) => (
          <ThreadCard key={thread.id} thread={thread} onSendToSession={onSendThread} />
        ))}
      </div>
    );
  }
  if (item.kind === "comment") {
    return (
      <div className="pr-detail-comment">
        <div className="pr-detail-comment-head"><strong>{item.actor}</strong> commented · {ageLabel(item.at)} ago</div>
        <Md text={item.body} allowImages={false} />
      </div>
    );
  }
  if (item.kind === "review_requested") {
    return (
      <div className="pr-detail-event">
        <span className="pr-detail-event-dot info"><Eye size={13} aria-hidden="true" /></span>
        <span><strong>{item.actor}</strong> requested review from <strong>{item.reviewer}</strong> · {ageLabel(item.at)} ago</span>
      </div>
    );
  }
  return (
    <div className="pr-detail-event">
      <span className={`pr-detail-event-dot${item.kind === "merged" ? " ok" : item.kind === "closed" ? " bad" : ""}`}>
        {item.kind === "merged" ? <GitMerge size={13} aria-hidden="true" /> : item.kind === "reopened" ? <RefreshCw size={13} aria-hidden="true" /> : item.kind === "ready_for_review" ? <Eye size={13} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
      </span>
      <span><strong>{item.actor}</strong> {eventVerb(item.kind)} · {ageLabel(item.at)} ago</span>
    </div>
  );
}

function CommitsTab({ detail }: { detail: PrDetail }) {
  if (detail.commits.length === 0) return <div className="pr-view-empty">No commits.</div>;
  return (
    <div className="pr-detail-commit-list">
      {detail.commits.map((commit) => (
        <div className="pr-detail-commit-list-row" key={commit.oid}>
          {commit.ci === "failing" ? <X size={13} className="bad" aria-hidden="true" /> : commit.ci === "passing" ? <Check size={13} className="ok" aria-hidden="true" /> : <span />}
          <div className="pr-detail-commit-list-copy">
            <div>{commit.headline}</div>
            <div className="pr-detail-commit-list-meta">{commit.author} · {ageLabel(commit.committedAt)} ago</div>
          </div>
          <span className="pr-detail-commit-sha">{shortSha(commit.oid)}</span>
        </div>
      ))}
    </div>
  );
}

function ChecksTab({
  checkGroups,
  selectedIndex,
  selectedCheck,
  onSelectCheck,
  log,
  logLoading,
  logError,
  onRetryLog,
  expandedLogRunId,
  onExpandLog,
  onFixCi
}: {
  checkGroups: Array<[string, Array<{ check: PrCheck; index: number }>]>;
  selectedIndex: number | null;
  selectedCheck: PrCheck | null;
  onSelectCheck: (index: number) => void;
  log: string | undefined;
  logLoading: boolean;
  logError: string | undefined;
  onRetryLog: () => void;
  expandedLogRunId: number | null;
  onExpandLog: (runId: number) => void;
  onFixCi: (() => void) | null;
}) {
  if (checkGroups.length === 0) return <div className="pr-view-empty">No checks reported.</div>;
  const checkUrl = selectedCheck?.url ?? null;
  const failingRunId = selectedCheck && selectedCheck.status === "failure" ? selectedCheck.runId : null;
  const logLines = log !== undefined ? log.split("\n") : [];
  const logTruncated = failingRunId !== null && expandedLogRunId !== failingRunId && logLines.length > MAX_LOG_LINES;
  const shownLogLines = logTruncated ? logLines.slice(-MAX_LOG_LINES) : logLines;
  return (
    <div className="pr-detail-checks">
      <div className="pr-detail-checks-list">
        {checkGroups.map(([groupName, items]) => (
          <div key={groupName}>
            <div className="pr-detail-checks-group">{groupName}</div>
            {items.map(({ check, index }) => (
              <button
                key={`${check.workflow ?? ""}-${check.name}-${index}`}
                className={`pr-detail-check-item${selectedIndex === index ? " active" : ""}`}
                onClick={() => onSelectCheck(index)}
              >
                {check.status === "failure" ? (
                  <CircleX size={13} className="bad" aria-hidden="true" />
                ) : check.status === "success" ? (
                  <CircleCheck size={13} className="ok" aria-hidden="true" />
                ) : check.status === "pending" ? (
                  <RefreshCw size={13} aria-hidden="true" />
                ) : (
                  <Check size={13} aria-hidden="true" />
                )}
                <span className="grow">{check.name}</span>
                {check.url && <ExternalLink size={12} aria-hidden="true" />}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="pr-detail-check-log-pane">
        {selectedCheck ? (
          <>
            <div className="pr-detail-check-log-head">
              {selectedCheck.status === "failure" ? <CircleX size={16} className="bad" aria-hidden="true" /> : <CircleCheck size={16} className="ok" aria-hidden="true" />}
              <div className="grow">
                <strong>{selectedCheck.name}</strong>
              </div>
              {selectedCheck.status === "failure" && onFixCi && (
                <button className="pr-detail-btn primary" onClick={onFixCi}>
                  <Wrench size={13} aria-hidden="true" />
                  Fix CI…
                </button>
              )}
              {checkUrl && (
                <button className="icon-btn" title="Open on GitHub" onClick={() => openExternalLink(checkUrl)}>
                  <ExternalLink size={13} aria-hidden="true" />
                </button>
              )}
            </div>
            {failingRunId !== null && (
              <div className="pr-detail-check-log">
                {logLoading && <div className="pr-detail-check-empty">Loading log…</div>}
                {logError && (
                  <div className="pr-detail-check-empty">
                    {logError}
                    <button className="pr-detail-btn ghost sm" onClick={onRetryLog}>Retry</button>
                  </div>
                )}
                {log !== undefined && (
                  <>
                    {logTruncated && (
                      <div className="pr-detail-check-log-note">
                        <span>Showing the last {MAX_LOG_LINES} of {logLines.length} lines.</span>
                        <button className="pr-detail-btn ghost sm" onClick={() => onExpandLog(failingRunId)}>Show full log</button>
                        {checkUrl && (
                          <button className="pr-detail-btn ghost sm" onClick={() => openExternalLink(checkUrl)}>Open on GitHub</button>
                        )}
                      </div>
                    )}
                    <pre className="pr-detail-check-log-pre">{shownLogLines.join("\n")}</pre>
                  </>
                )}
              </div>
            )}
            {selectedCheck.status !== "failure" && (
              <div className="pr-detail-check-empty">Logs are only available for failed checks in this view.</div>
            )}
            {selectedCheck.status === "failure" && selectedCheck.runId === null && (
              <div className="pr-detail-check-empty">No run log available for this check.</div>
            )}
          </>
        ) : (
          <div className="pr-detail-check-empty">Select a check to view details.</div>
        )}
      </div>
    </div>
  );
}

function SideColumn({
  detail,
  linkedSessions,
  workflows,
  suggested,
  onOpenSession,
  onRunWorkflow
}: {
  detail: PrDetail;
  linkedSessions: Session[];
  workflows: PrWorkflow[];
  suggested: PrWorkflow | null;
  onOpenSession: (sessionId: string) => void;
  onRunWorkflow: (workflowId: string) => void;
}) {
  const orderedWorkflows = useMemo(() => {
    const enabled = workflows.filter((w) => w.enabled);
    if (!suggested) return enabled;
    return [suggested, ...enabled.filter((w) => w.id !== suggested.id)];
  }, [workflows, suggested]);

  return (
    <aside className="pr-detail-side">
      <div className="pr-detail-side-block">
        <div className="pr-detail-side-title">cw-code sessions<span className="grow" /><span className="faint">{linkedSessions.length}</span></div>
        {linkedSessions.length === 0 && <div className="pr-detail-side-empty">None yet.</div>}
        {linkedSessions.map((session) => (
          <button className="pr-detail-session-row" key={session.id} onClick={() => onOpenSession(session.id)}>
            <DriverIcon driver={session.driver} size={13} />
            <span className="pr-detail-session-copy">
              <span>{session.title}</span>
              <span className="pr-detail-session-meta">{linkFor(session, detail.ref)?.origin ?? "linked"} · {ageLabel(session.updatedAt)} ago</span>
            </span>
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="pr-detail-side-block">
        <div className="pr-detail-side-title">Run workflow</div>
        <div className="pr-detail-side-workflows">
          {orderedWorkflows.map((workflow) => {
            const Icon = workflowIcon(workflow.icon);
            return (
              <button
                key={workflow.id}
                className={`pr-detail-btn workflow${workflow.id === suggested?.id ? " primary" : ""}`}
                onClick={() => onRunWorkflow(workflow.id)}
              >
                <Icon size={13} aria-hidden="true" />
                {workflow.label}
                {workflow.id === suggested?.id && <span className="pr-detail-suggested-tag">suggested</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="pr-detail-side-block">
        <div className="pr-detail-side-title">Reviewers</div>
        {detail.reviewers.length === 0 && <div className="pr-detail-side-empty">No reviewers requested.</div>}
        {detail.reviewers.map((reviewer) => (
          <div className="pr-detail-reviewer-row" key={reviewer.login}>
            <span>{reviewer.login}</span>
            <span className="grow" />
            {reviewer.state === "APPROVED" && <span title="Approved"><CircleCheck size={14} className="ok" aria-hidden="true" /></span>}
            {reviewer.state === "CHANGES_REQUESTED" && <span title="Changes requested"><CircleX size={14} className="bad" aria-hidden="true" /></span>}
            {reviewer.state === "COMMENTED" && <span title="Commented"><MessageSquare size={14} aria-hidden="true" /></span>}
            {reviewer.state === "PENDING" && <span title="Pending"><Eye size={14} aria-hidden="true" /></span>}
          </div>
        ))}
      </div>
      <div className="pr-detail-side-block">
        <div className="pr-detail-side-title">Labels</div>
        <div className="pr-detail-labels">
          {detail.labels.length === 0 && <span className="faint">None</span>}
          {detail.labels.map((label) => (
            <span className="pr-detail-label" key={label}>{label}</span>
          ))}
        </div>
      </div>
      <div className="pr-detail-side-block last">
        <div className="pr-detail-side-title">Details</div>
        <div className="pr-detail-detail-row"><span className="faint">Repository</span><span className="grow" />{detail.ref.owner}/{detail.ref.repo}</div>
        <div className="pr-detail-detail-row"><span className="faint">Head SHA</span><span className="grow" /><code>{shortSha(detail.headRefOid)}</code></div>
        <div className="pr-detail-detail-row"><span className="faint">Updated</span><span className="grow" />{ageLabel(detail.updatedAt)} ago</div>
      </div>
    </aside>
  );
}
