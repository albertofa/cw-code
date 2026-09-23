import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  CircleCheck,
  CircleX,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Download,
  ExternalLink,
  Eye,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Loader,
  MessageSquare,
  RefreshCw,
  type LucideIcon
} from "lucide-react";
import type { PrBucket, PrRef, PrSummary, PrWorkflow, Session } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePanelStore } from "../stores/panelStore.js";
import { usePrStore } from "../stores/prStore.js";
import { PanelToggles } from "./PanelToggles.js";
import { projectAvatarStyle, projectInitials } from "./avatar.js";
import { DriverIcon } from "./DriverIcon.js";
import { prKey } from "./prInbox.js";
import { hasUnseen } from "./prUpdates.js";
import {
  BUCKET_HINT,
  BUCKET_TITLE,
  DEFAULT_COLLAPSED_BUCKETS,
  PR_INBOX_FILTERS,
  buildInboxRows,
  filterCounts,
  formatRelativeAge,
  groupRowsByBucket,
  matchesFilter,
  rowDeltaText,
  type PrInboxFilterId,
  type PrInboxRow
} from "./prInboxModel.js";
import { primaryAction, suggestedWorkflow } from "./prWorkflows.js";
import { errorMessage } from "./errorMessage.js";
import { usePrSettings } from "./useLinkedPr.js";

function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const FILTER_ICONS: Partial<Record<PrInboxFilterId, LucideIcon>> = {
  review: Eye,
  action: AlertTriangle,
  "with-session": MessageSquare,
  "not-cloned": Download
};

const BUCKET_ICONS: Record<PrBucket, LucideIcon> = {
  review: Eye,
  action: AlertTriangle,
  ready: GitMerge,
  waiting: Clock,
  merged: GitMerge
};

const BUCKET_ICON_TONE: Record<PrBucket, string> = {
  review: "info",
  action: "warn",
  ready: "ok",
  waiting: "neutral",
  merged: "neutral"
};

interface Tone {
  tone: "ok" | "bad" | "warn" | "info" | "neutral";
  Icon: LucideIcon;
  text: string;
  spin?: boolean;
}

function checksTone(pr: PrSummary): Tone {
  const { total, passed, failed, pending } = pr.checks;
  if (pr.ci === "failing") return { tone: "bad", Icon: CircleX, text: total > 0 ? `${failed} failing` : "checks failing" };
  if (pr.ci === "pending") return { tone: "warn", Icon: Loader, text: total > 0 ? `${pending} pending` : "checks running", spin: true };
  if (pr.ci === "passing") return { tone: "ok", Icon: CircleCheck, text: total > 0 ? `${passed}/${total} passed` : "checks passed" };
  return { tone: "neutral", Icon: Circle, text: "no checks" };
}

function reviewTone(pr: PrSummary): Tone {
  if (pr.mergeable === "CONFLICTING") return { tone: "bad", Icon: AlertTriangle, text: "Conflicts" };
  if (pr.review === "approved") return { tone: "ok", Icon: Check, text: "Approved" };
  if (pr.review === "changes_requested") return { tone: "bad", Icon: MessageSquare, text: "Changes requested" };
  if (pr.review === "review_required") {
    return pr.reviewRequestedFromViewer
      ? { tone: "info", Icon: Eye, text: "Your review" }
      : { tone: "warn", Icon: Clock, text: "Awaiting reviewers" };
  }
  return { tone: "neutral", Icon: Circle, text: "No reviewers" };
}

function originLabel(session: Session, workflows: PrWorkflow[]): string {
  const link = session.pr;
  if (!link) return "Linked";
  if (link.origin === "opened") return "Opened this PR";
  if (link.origin === "workflow") {
    const workflow = workflows.find((w) => w.id === link.workflowId);
    return `Workflow: ${workflow?.label ?? link.workflowId ?? "unknown"}`;
  }
  return "Linked";
}

function fallbackWorkflow(pr: PrSummary, workflows: PrWorkflow[]): PrWorkflow | null {
  return suggestedWorkflow(pr, workflows) ?? workflows.find((w) => w.enabled) ?? null;
}

function StateIcon({ pr }: { pr: PrSummary }) {
  if (pr.state === "MERGED") {
    return (
      <span className="pr-inbox-state tone-merged" title="Merged">
        <GitMerge size={14} aria-hidden="true" />
      </span>
    );
  }
  if (pr.isDraft) {
    return (
      <span className="pr-inbox-state tone-neutral" title="Draft">
        <GitPullRequestDraft size={14} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="pr-inbox-state tone-ok" title="Open">
      <GitPullRequest size={14} aria-hidden="true" />
    </span>
  );
}

function Signal({ tone, Icon, text, spin, title, className }: Tone & { title?: string; className?: string }) {
  return (
    <span className={`pr-inbox-signal tone-${tone}${className ? ` ${className}` : ""}`} title={title ?? text}>
      <Icon size={13} aria-hidden="true" className={spin ? "pr-inbox-spin" : undefined} />
      <span>{text}</span>
    </span>
  );
}

function SyncedLabel({ fetchedAt, loading }: { fetchedAt: number | null; loading: boolean }) {
  const now = useNow();
  return (
    <span className="pr-inbox-synced">
      <RefreshCw size={12} aria-hidden="true" className={loading ? "pr-inbox-spin" : undefined} />
      {fetchedAt !== null ? `synced ${formatRelativeAge(fetchedAt, now)} ago via ` : "not synced yet via "}
      <span className="pr-inbox-mono">gh</span>
    </span>
  );
}

interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function anchorRectOf(el: HTMLElement): AnchorRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

function InboxPopover({
  anchor,
  align = "left",
  label,
  onClose,
  className,
  children
}: {
  anchor: AnchorRect;
  align?: "left" | "right";
  label: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(() => ({ left: anchor.left, top: anchor.bottom + 4 }));

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rawLeft = align === "right" ? anchor.right - rect.width : anchor.left;
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - rect.height - 8));
    setPos({ left, top });
  }, [anchor, align]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        className={`pr-inbox-popover${className ? ` ${className}` : ""}`}
        style={{ left: pos.left, top: pos.top }}
        aria-label={label}
      >
        {children}
      </div>
    </>
  );
}

function SessionsPopoverContent({
  row,
  workflows,
  onSelect
}: {
  row: PrInboxRow;
  workflows: PrWorkflow[];
  onSelect: (sessionId: string) => void;
}) {
  const now = useNow();
  return (
    <>
      <div className="pr-inbox-popover-head">Sessions linked to #{row.pr.ref.number}</div>
      {row.linkedSessions.length === 0 && <div className="pr-inbox-popover-empty">No linked sessions.</div>}
      {row.linkedSessions.map((session) => {
        const unseen = session.pr ? hasUnseen(row.pr, session.pr) : false;
        return (
          <button key={session.id} type="button" className="pr-inbox-popover-row" onClick={() => onSelect(session.id)}>
            <DriverIcon driver={session.driver} size={14} />
            <span className="pr-inbox-popover-row-text">
              <span className="pr-inbox-popover-row-title">{session.title}</span>
              <span className="pr-inbox-popover-row-sub">
                {originLabel(session, workflows)} · active {formatRelativeAge(session.updatedAt, now)} ago
              </span>
            </span>
            {unseen && <span className="pr-inbox-popover-badge">new</span>}
          </button>
        );
      })}
    </>
  );
}

function WorkflowPopoverContent({
  workflows,
  suggestedId,
  onPick,
  onOpenExternal
}: {
  workflows: PrWorkflow[];
  suggestedId: string | null;
  onPick: (workflowId: string) => void;
  onOpenExternal: () => void;
}) {
  const enabled = workflows.filter((w) => w.enabled);
  return (
    <>
      {enabled.map((workflow) => (
        <button key={workflow.id} type="button" className="pr-inbox-popover-item" onClick={() => onPick(workflow.id)}>
          <span>{workflow.label}</span>
          {workflow.id === suggestedId && <span className="pr-inbox-popover-suggested">Suggested</span>}
        </button>
      ))}
      {enabled.length > 0 && <div className="pr-inbox-popover-sep" />}
      <button type="button" className="pr-inbox-popover-item" onClick={onOpenExternal}>
        <ExternalLink size={13} aria-hidden="true" />
        <span>Open on GitHub</span>
      </button>
    </>
  );
}

interface SessionsPopoverState {
  key: string;
  anchor: AnchorRect;
}

interface WorkflowPopoverState {
  key: string;
  anchor: AnchorRect;
  ref: PrRef;
  url: string;
}

export function PrInboxView() {
  const inbox = usePrStore((s) => s.inbox);
  const loading = usePrStore((s) => s.inboxLoading);
  const error = usePrStore((s) => s.inboxError);
  const refreshInbox = usePrStore((s) => s.refreshInbox);
  const openPr = usePrStore((s) => s.openPr);
  const openSessionView = usePrStore((s) => s.openSessionView);
  const openRunModal = usePrStore((s) => s.openRunModal);
  const projectIdForRef = usePrStore((s) => s.projectIdForRef);
  const projectRepos = usePrStore((s) => s.projectRepos);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const selectSession = useAppStore((s) => s.selectSession);
  const rightVisible = usePanelStore((s) => s.rightVisible);

  const [filter, setFilter] = useState<PrInboxFilterId>("all");
  const [collapsed, setCollapsed] = useState<Set<PrBucket>>(() => new Set(DEFAULT_COLLAPSED_BUCKETS));
  const { settings, error: workflowsError, reload: reloadWorkflows } = usePrSettings();
  const workflows = useMemo<PrWorkflow[]>(() => settings?.prWorkflows ?? [], [settings]);
  const [sessionsPopover, setSessionsPopover] = useState<SessionsPopoverState | null>(null);
  const [workflowPopover, setWorkflowPopover] = useState<WorkflowPopoverState | null>(null);

  const items = inbox?.items ?? [];
  const failure = error ?? inbox?.error ?? null;

  const allSessions = useMemo(() => Object.values(sessionsByProject).flat(), [sessionsByProject]);
  const rows = useMemo(
    () => buildInboxRows(items, allSessions, (ref) => projectIdForRef(ref) !== null),
    [items, allSessions, projectIdForRef, projectRepos]
  );
  const visibleRows = useMemo(() => rows.filter((row) => matchesFilter(row, filter)), [rows, filter]);
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const groups = useMemo(() => groupRowsByBucket(visibleRows), [visibleRows]);

  const toggleBucket = (bucket: PrBucket) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  };

  const goToSession = (sessionId: string) => {
    setSessionsPopover(null);
    setWorkflowPopover(null);
    openSessionView();
    selectSession(sessionId);
  };

  const runWorkflow = (ref: PrRef, workflowId: string, continueSessionId?: string) => {
    setSessionsPopover(null);
    setWorkflowPopover(null);
    openRunModal({ workflowId, ref, continueSessionId });
  };

  const openExternalLink = (url: string) => {
    void window.cw.openExternal(url).catch((err: unknown) => console.warn(`[pr-inbox] failed to open ${url}: ${errorMessage(err)}`));
  };

  const sessionsRow = sessionsPopover ? (rows.find((row) => prKey(row.pr.ref) === sessionsPopover.key) ?? null) : null;
  const workflowRow = workflowPopover ? (rows.find((row) => prKey(row.pr.ref) === workflowPopover.key) ?? null) : null;

  return (
    <div className="thread-col pr-view pr-inbox-view">
      <div className="head-seg main-seg" onDoubleClick={() => window.cw.toggleMaximizeWindow()}>
        <div className="head-col col-left">
          <div className="titlebar-crumb">
            <strong>Pull requests</strong>
            {inbox?.account && <span className="pr-view-account">@{inbox.account.login}</span>}
          </div>
        </div>
        <div className="head-col col-mid" />
        <div className="head-col col-right">{!rightVisible && <PanelToggles />}</div>
      </div>
      <div className="pr-view-body pr-inbox-body">
        {failure && (
          <div className="pr-view-error" role="alert">
            <span>{failure}</span>
            <button type="button" className="pr-view-retry" onClick={() => void refreshInbox(true)}>
              Retry
            </button>
          </div>
        )}
        {workflowsError && (
          <div className="pr-view-error" role="alert">
            <span>Could not load workflows: {workflowsError}</span>
            <button type="button" className="pr-view-retry" onClick={reloadWorkflows}>
              Retry
            </button>
          </div>
        )}

        <div className="pr-inbox-toolbar">
          <SyncedLabel fetchedAt={inbox?.fetchedAt ?? null} loading={loading} />
          {inbox?.truncated && (
            <span className="pr-inbox-truncated" title="GitHub search returns at most 50 pull requests per query; older ones may be missing">
              at most 50 per search
            </span>
          )}
          <span className="pr-inbox-toolbar-grow" />
          <button
            type="button"
            className="icon-btn"
            onClick={() => void refreshInbox(true)}
            disabled={loading}
            title="Refresh pull requests"
            aria-label="Refresh pull requests"
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="pr-inbox-chips">
          {PR_INBOX_FILTERS.map((chipFilter) => {
            const Icon = FILTER_ICONS[chipFilter.id];
            return (
              <button
                key={chipFilter.id}
                type="button"
                className={`pr-inbox-chip${filter === chipFilter.id ? " active" : ""}`}
                aria-pressed={filter === chipFilter.id}
                onClick={() => setFilter(chipFilter.id)}
              >
                {Icon ? (
                  <Icon size={12} aria-hidden="true" />
                ) : chipFilter.id === "updated" ? (
                  <span className="pr-unseen-dot" aria-hidden="true" />
                ) : null}
                {chipFilter.label}
                <b>{counts[chipFilter.id]}</b>
              </button>
            );
          })}
        </div>

        {loading && items.length === 0 && <div className="pr-view-empty">Loading pull requests…</div>}
        {!loading && !failure && inbox && rows.length === 0 && <div className="pr-view-empty">No open pull requests involve you.</div>}
        {!loading && !failure && inbox && rows.length > 0 && visibleRows.length === 0 && (
          <div className="pr-view-empty">No pull requests match this filter.</div>
        )}

        {groups.length > 0 && (
          <div className="pr-inbox-groups">
            {groups.map((group) => {
              const isCollapsed = collapsed.has(group.bucket);
              const BucketIcon = BUCKET_ICONS[group.bucket];
              return (
                <section key={group.bucket} className={`pr-inbox-group${isCollapsed ? " collapsed" : ""}`}>
                  <button
                    type="button"
                    className="pr-inbox-group-head"
                    onClick={() => toggleBucket(group.bucket)}
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                    <BucketIcon size={13} aria-hidden="true" className={`pr-inbox-group-icon tone-${BUCKET_ICON_TONE[group.bucket]}`} />
                    <span className="pr-inbox-group-title">{BUCKET_TITLE[group.bucket]}</span>
                    <span className="pr-inbox-group-count">{group.rows.length}</span>
                    <span className="pr-inbox-group-hint">{BUCKET_HINT[group.bucket]}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="pr-inbox-rows">
                      {group.rows.map((row) => {
                        const key = prKey(row.pr.ref);
                        return (
                          <PrRow
                            key={key}
                            row={row}
                            workflows={workflows}
                            sessionsOpen={sessionsPopover?.key === key}
                            workflowMenuOpen={workflowPopover?.key === key}
                            onOpen={() => openPr(row.pr.ref)}
                            onOpenSessions={(el) => setSessionsPopover({ key, anchor: anchorRectOf(el) })}
                            onOpenWorkflowMenu={(el) => setWorkflowPopover({ key, anchor: anchorRectOf(el), ref: row.pr.ref, url: row.pr.url })}
                            onGoToSession={goToSession}
                            onRunWorkflow={runWorkflow}
                            onOpenExternal={openExternalLink}
                          />
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      {sessionsPopover && sessionsRow && (
        <InboxPopover
          anchor={sessionsPopover.anchor}
          align="left"
          label={`Sessions linked to #${sessionsRow.pr.ref.number}`}
          onClose={() => setSessionsPopover(null)}
        >
          <SessionsPopoverContent row={sessionsRow} workflows={workflows} onSelect={goToSession} />
        </InboxPopover>
      )}

      {workflowPopover && (
        <InboxPopover anchor={workflowPopover.anchor} align="right" label="Run a workflow" onClose={() => setWorkflowPopover(null)}>
          <WorkflowPopoverContent
            workflows={workflows}
            suggestedId={workflowRow ? (suggestedWorkflow(workflowRow.pr, workflows)?.id ?? null) : null}
            onPick={(workflowId) => runWorkflow(workflowPopover.ref, workflowId)}
            onOpenExternal={() => {
              setWorkflowPopover(null);
              openExternalLink(workflowPopover.url);
            }}
          />
        </InboxPopover>
      )}
    </div>
  );
}

function PrRow({
  row,
  workflows,
  sessionsOpen,
  workflowMenuOpen,
  onOpen,
  onOpenSessions,
  onOpenWorkflowMenu,
  onGoToSession,
  onRunWorkflow,
  onOpenExternal
}: {
  row: PrInboxRow;
  workflows: PrWorkflow[];
  sessionsOpen: boolean;
  workflowMenuOpen: boolean;
  onOpen: () => void;
  onOpenSessions: (el: HTMLElement) => void;
  onOpenWorkflowMenu: (el: HTMLElement) => void;
  onGoToSession: (sessionId: string) => void;
  onRunWorkflow: (ref: PrRef, workflowId: string, continueSessionId?: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const now = useNow();
  const { pr } = row;
  const checks = checksTone(pr);
  const review = reviewTone(pr);
  const action = primaryAction(pr, row.linkedSessions, workflows);
  const fallback = action.kind === "none" && pr.state !== "MERGED" ? fallbackWorkflow(pr, workflows) : null;
  const initials = projectInitials(pr.author.login);
  const avatarCss = projectAvatarStyle(pr.author.login);
  const delta = rowDeltaText(row, now);
  const showCaret = pr.state !== "MERGED";

  const primaryLabel = (() => {
    if (action.kind === "open") return "Open session";
    if (action.kind === "continue") return "Re-review";
    if (action.kind === "run") return workflows.find((w) => w.id === action.workflowId)?.label ?? action.workflowId;
    if (fallback) return fallback.label;
    return "GitHub";
  })();

  const primaryHandler = () => {
    if (action.kind === "open") onGoToSession(action.sessionId);
    else if (action.kind === "continue") onRunWorkflow(pr.ref, action.workflowId, action.sessionId);
    else if (action.kind === "run") onRunWorkflow(pr.ref, action.workflowId);
    else if (fallback) onRunWorkflow(pr.ref, fallback.id);
    else onOpenExternal(pr.url);
  };

  return (
    <div className={`pr-inbox-row${row.hasUnseenSession ? "" : " seen"}`} onClick={onOpen}>
      <span className="pr-inbox-row-dot-cell">{row.hasUnseenSession && <span className="pr-unseen-dot" title="Updated since you last looked" />}</span>
      <StateIcon pr={pr} />
      <div className="pr-inbox-title-col">
        <div className="pr-inbox-title-line">
          <button
            type="button"
            className="pr-inbox-title-link"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            {pr.title}
          </button>
          {pr.labels.map((label) => (
            <span key={label} className="pr-inbox-label">
              {label}
            </span>
          ))}
        </div>
        <div className="pr-inbox-meta-line">
          <span className="pr-inbox-repo">
            {pr.ref.owner}/{pr.ref.repo}
          </span>
          <span className="pr-inbox-meta-sep">·</span>
          <span>#{pr.ref.number}</span>
          <span className="pr-inbox-meta-sep">·</span>
          <span className="avatar sm pr-inbox-avatar" style={avatarCss} aria-hidden="true">
            {initials}
          </span>
          <span>{pr.author.login}</span>
          {delta && (
            <>
              <span className="pr-inbox-meta-sep">·</span>
              <span className="pr-inbox-delta">{delta}</span>
            </>
          )}
          {!row.cloned && <span className="pr-inbox-not-cloned">not cloned</span>}
        </div>
      </div>
      <Signal {...checks} className="pr-inbox-col-checks" />
      <Signal {...review} className="pr-inbox-col-review" />
      <span
        className="pr-inbox-signal tone-neutral pr-inbox-col-comments"
        title={`${pr.commentsCount} comments${pr.unresolvedThreads ? `, ${pr.unresolvedThreads} unresolved` : ""}`}
      >
        <MessageSquare size={13} aria-hidden="true" />
        <span>
          {pr.commentsCount}
          {pr.unresolvedThreads > 0 && <span className="pr-inbox-unresolved"> · {pr.unresolvedThreads}</span>}
        </span>
      </span>
      <div className="pr-inbox-size pr-inbox-col-size">
        <span className="pr-inbox-size-line">
          <span className="pr-inbox-add">+{pr.additions}</span> <span className="pr-inbox-del">−{pr.deletions}</span>
        </span>
        <span className="pr-inbox-age">{formatRelativeAge(pr.updatedAt, now)} ago</span>
      </div>
      <button
        type="button"
        className="pr-inbox-sessions"
        aria-expanded={sessionsOpen}
        title={row.linkedSessions.length > 0 ? `${row.linkedSessions.length} linked session(s)` : "No linked sessions"}
        onClick={(e) => {
          e.stopPropagation();
          if (row.linkedSessions.length === 0) return;
          onOpenSessions(e.currentTarget);
        }}
      >
        {row.linkedSessions.length === 0 ? (
          <span className="pr-inbox-sessions-empty">—</span>
        ) : (
          <>
            {row.linkedSessions.slice(0, 3).map((session) => (
              <DriverIcon key={session.id} driver={session.driver} size={13} />
            ))}
            {row.linkedSessions.length > 1 && <span className="pr-inbox-session-count">{row.linkedSessions.length}</span>}
            {row.hasUnseenSession && <span className="pr-unseen-dot" aria-hidden="true" />}
          </>
        )}
      </button>
      <div className="pr-inbox-action" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn pr-inbox-action-btn" onClick={primaryHandler}>
          {primaryLabel}
        </button>
        {showCaret && (
          <button
            type="button"
            className="btn pr-inbox-action-caret"
            title="Run a workflow"
            aria-expanded={workflowMenuOpen}
            onClick={(e) => onOpenWorkflowMenu(e.currentTarget)}
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
