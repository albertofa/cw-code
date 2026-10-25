import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  CalendarClock,
  ChevronRight,
  CircleX,
  Clock,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Loader,
  MessageSquare,
  Milestone,
  Timer,
  User,
  Users,
  Workflow
} from "lucide-react";
import type { IssueSummary, PrReviewer, PrSummary, WorkflowRunSummary } from "../cw.js";
import { usePrStore } from "../stores/prStore.js";
import { anchorRectOf, type AnchorRect } from "./AnchoredPopover.js";
import { GitHubAvatar } from "./GitHubAvatar.js";
import { DiffBar, VerdictGlyph } from "./GitHubVerdictIcon.js";
import { openExternalLink } from "./externalLink.js";
import {
  formatDuration,
  isJobFailed,
  isJobSuccessful,
  issueVerdict,
  linkedPrVerdict,
  prGates,
  prVerdict,
  reviewerBadge,
  runDurationMs,
  avatarUrlOf,
  sameLogin,
  stateGlyph,
  type Tone
} from "./githubRowModel.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { prRefFromUrl } from "@cw-code/shared/prRef";

const SHOW_DELAY_MS = 280;
const SWITCH_DELAY_MS = 60;
const HIDE_DELAY_MS = 140;
const CARD_GAP = 6;
const VIEWPORT_MARGIN = 8;

let activeClose: (() => void) | null = null;

function HoverCardPanel({
  anchor,
  anchorEl,
  onEnter,
  onLeave,
  onDismiss,
  children
}: {
  anchor: AnchorRect;
  anchorEl: HTMLElement | null;
  onEnter: () => void;
  onLeave: () => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(() => ({ left: anchor.left, top: anchor.bottom + CARD_GAP }));

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, window.innerWidth - rect.width - VIEWPORT_MARGIN));
    const below = anchor.bottom + CARD_GAP;
    const fitsBelow = below + rect.height <= window.innerHeight - VIEWPORT_MARGIN;
    const top = fitsBelow ? below : Math.max(VIEWPORT_MARGIN, anchor.top - rect.height - CARD_GAP);
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    const onScroll = (e: Event) => {
      if (anchorEl && e.target instanceof Node && e.target.contains(anchorEl)) onDismiss();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchorEl, onDismiss]);

  return createPortal(
    <div
      ref={panelRef}
      className="session-hovercard interactive hub-card"
      style={{ left: pos.left, top: pos.top }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
}

export function HoverCard({ className, card, children }: { className: string; card: ReactNode; children: ReactNode }) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const openRef = useRef(false);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);

  const close = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    openRef.current = false;
    setAnchor(null);
    if (activeClose === close) activeClose = null;
  }, []);

  useEffect(() => close, [close]);

  const open = () => {
    const el = anchorRef.current;
    if (!el) return;
    if (activeClose && activeClose !== close) activeClose();
    activeClose = close;
    openRef.current = true;
    setAnchor(anchorRectOf(el));
  };

  const cancelHide = () => window.clearTimeout(hideTimer.current);

  const scheduleHide = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    if (openRef.current) hideTimer.current = window.setTimeout(close, HIDE_DELAY_MS);
  };

  const onEnter = () => {
    cancelHide();
    if (openRef.current) return;
    window.clearTimeout(showTimer.current);
    showTimer.current = window.setTimeout(open, activeClose ? SWITCH_DELAY_MS : SHOW_DELAY_MS);
  };

  return (
    <>
      <div ref={anchorRef} className={`${className}${anchor ? " card-open" : ""}`} onMouseEnter={onEnter} onMouseLeave={scheduleHide}>
        {children}
      </div>
      {anchor && (
        <HoverCardPanel anchor={anchor} anchorEl={anchorRef.current} onEnter={cancelHide} onLeave={scheduleHide} onDismiss={close}>
          {card}
        </HoverCardPanel>
      )}
    </>
  );
}

function PersonLine({
  login,
  avatarUrl,
  viewer,
  end,
  endTone
}: {
  login: string;
  avatarUrl?: string;
  viewer: string | null;
  end?: string;
  endTone?: Tone;
}) {
  return (
    <div className="hub-card-line">
      <GitHubAvatar login={login} avatarUrl={avatarUrl} small />
      <span className="grow">{login}</span>
      {sameLogin(login, viewer) && <span className="hub-card-you">you</span>}
      {end && <span className={`end${endTone ? ` tone-${endTone}` : ""}`}>{end}</span>}
    </div>
  );
}

function CardSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="hub-card-sec">
      <span className="hub-card-label">{label}</span>
      <div className="hub-card-body">{children}</div>
    </div>
  );
}

const REVIEW_STATE_TEXT: Record<PrReviewer["state"], string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Commented",
  PENDING: "Review requested"
};

const REVIEW_SUMMARY_ORDER: Array<[PrReviewer["state"], string]> = [
  ["APPROVED", "approved"],
  ["CHANGES_REQUESTED", "requested changes"],
  ["PENDING", "pending"],
  ["COMMENTED", "commented"]
];

function reviewSummary(reviewers: PrReviewer[]): string {
  return REVIEW_SUMMARY_ORDER.map(([state, text]) => ({ count: reviewers.filter((reviewer) => reviewer.state === state).length, text }))
    .filter(({ count }) => count > 0)
    .map(({ count, text }) => `${count} ${text}`)
    .join(" · ");
}

function RunEventIcon({ event }: { event: string }) {
  if (event === "schedule") return <CalendarClock size={13} aria-hidden="true" className="tone-neutral" />;
  if (event === "push") return <GitCommitHorizontal size={13} aria-hidden="true" className="tone-neutral" />;
  return <GitPullRequest size={13} aria-hidden="true" className="tone-neutral" />;
}

export type HoverSubject =
  | { kind: "pr"; item: PrSummary }
  | { kind: "issue"; item: IssueSummary }
  | { kind: "run"; item: WorkflowRunSummary };

export function PeopleCard({ subject, viewer }: { subject: HoverSubject; viewer: string | null }) {
  if (subject.kind === "run") {
    const run = subject.item;
    return (
      <>
        <div className="hub-card-head">
          <User size={13} aria-hidden="true" />
          Triggered by
        </div>
        <CardSection label="Actor">
          {run.actor ? <PersonLine login={run.actor} avatarUrl={run.actorAvatarUrl} viewer={viewer} /> : <span className="tone-neutral">Unknown</span>}
        </CardSection>
        <CardSection label="Event">
          <div className="hub-card-line">
            <RunEventIcon event={run.event} />
            <span className="grow">
              {run.event}
              {run.prNumber !== null ? ` · PR #${run.prNumber}` : ""}
            </span>
          </div>
        </CardSection>
      </>
    );
  }
  const item = subject.item;
  const reviewers = subject.kind === "pr" ? subject.item.reviewers : [];
  return (
    <>
      <div className="hub-card-head">
        <Users size={13} aria-hidden="true" />
        People
        <span className="sub">
          {item.ref.repo}#{item.ref.number}
        </span>
      </div>
      <CardSection label="Author">
        <PersonLine login={item.author.login} avatarUrl={avatarUrlOf(item, item.author.login)} viewer={viewer} />
      </CardSection>
      <CardSection label="Assignees">
        {item.assignees.length > 0 ? (
          item.assignees.map((login) => <PersonLine key={login} login={login} avatarUrl={avatarUrlOf(item, login)} viewer={viewer} />)
        ) : (
          <span className="tone-neutral">None</span>
        )}
      </CardSection>
      {subject.kind === "pr" && (
        <CardSection label="Reviewers">
          {reviewers.length > 0 ? (
            reviewers.map((reviewer) => (
              <PersonLine
                key={reviewer.login}
                login={reviewer.login}
                avatarUrl={avatarUrlOf(item, reviewer.login)}
                viewer={viewer}
                end={REVIEW_STATE_TEXT[reviewer.state]}
                endTone={reviewerBadge(reviewer.state)}
              />
            ))
          ) : (
            <span className="tone-neutral">No reviewers requested</span>
          )}
        </CardSection>
      )}
    </>
  );
}

function PrStatusCard({ pr, viewer }: { pr: PrSummary; viewer: string | null }) {
  const state = stateGlyph({ kind: "pr", pr });
  const openPr = usePrStore((s) => s.openPr);
  const verdict = prVerdict(pr, viewer);
  const gates = prGates(pr, viewer);
  const summary = reviewSummary(pr.reviewers);
  const { failed, pending } = pr.checks;
  return (
    <>
      <div className="hub-card-head">
        <VerdictGlyph verdict={state} />
        <span className={`tone-${state.tone}`}>{state.text}</span>
        <span className="tone-neutral">·</span>
        <span className={`tone-${verdict.tone}`}>{verdict.text}</span>
        <span className="sub">
          {pr.ref.repo}#{pr.ref.number}
        </span>
      </div>
      <CardSection label="Checks">
        <div className="hub-card-line strong">
          <VerdictGlyph verdict={gates.checks} size={12} />
          <span className="grow">{gates.checks.text}</span>
        </div>
        {failed > 0 && (
          <button type="button" className="hub-card-line click" onClick={() => openPr(pr.ref, "checks")}>
            <CircleX size={12} aria-hidden="true" className="tone-bad" />
            <span className="grow">{failed} failing</span>
            <span className="end">
              logs <ChevronRight size={11} aria-hidden="true" />
            </span>
          </button>
        )}
        {pending > 0 && (
          <div className="hub-card-line">
            <Loader size={12} aria-hidden="true" className="tone-warn pr-inbox-spin" />
            <span className="grow">{pending} running</span>
          </div>
        )}
      </CardSection>
      <CardSection label="Review">
        <div className="hub-card-line strong">
          <VerdictGlyph verdict={gates.review} size={12} />
          <span className="grow">{gates.review.text}</span>
        </div>
        {summary && <div className="hub-card-line hub-card-muted">{summary}</div>}
      </CardSection>
      <CardSection label="Merge">
        <div className="hub-card-line strong">
          <VerdictGlyph verdict={gates.merge} size={12} />
          <span className="grow">{gates.merge.text}</span>
        </div>
      </CardSection>
      <CardSection label="Changes">
        <div className="hub-card-line">
          <span className="hub-diff">
            <span className="pr-inbox-add">+{pr.additions}</span> <span className="pr-inbox-del">−{pr.deletions}</span>
          </span>
          <DiffBar additions={pr.additions} deletions={pr.deletions} />
          <span className="grow hub-card-muted">{pr.changedFiles} files</span>
        </div>
        <div className="hub-card-line">
          <GitBranch size={12} aria-hidden="true" className="tone-neutral" />
          <span className="grow hub-branch">
            {pr.headRefName} → {pr.baseRefName}
          </span>
        </div>
        <div className="hub-card-line">
          <MessageSquare size={12} aria-hidden="true" className="tone-neutral" />
          <span className="grow">
            {pr.commentsCount} comments
            {pr.unresolvedThreads > 0 && (
              <>
                {" · "}
                <span className="tone-bad">{pr.unresolvedThreads} unresolved</span>
              </>
            )}
          </span>
        </div>
      </CardSection>
    </>
  );
}

function IssueStatusCard({ issue, now }: { issue: IssueSummary; now: number }) {
  const openPr = usePrStore((s) => s.openPr);
  const verdict = issueVerdict(issue);
  const stateText = issue.state === "OPEN" ? "Open" : issue.stateReason === "NOT_PLANNED" ? "Closed · not planned" : "Closed · completed";
  const openLinked = (url: string) => {
    const ref = prRefFromUrl(url);
    if (ref) openPr(ref);
    else openExternalLink(url);
  };
  return (
    <>
      <div className="hub-card-head">
        <VerdictGlyph verdict={verdict} />
        <span className={`tone-${verdict.tone}`}>{stateText}</span>
        <span className="sub">
          {issue.ref.repo}#{issue.ref.number}
        </span>
      </div>
      <CardSection label="Linked PR">
        {issue.linkedPrs.length > 0 ? (
          issue.linkedPrs.map((linked) => {
            const linkedVerdict = linkedPrVerdict(linked);
            return (
              <button key={linked.number} type="button" className="hub-card-line click" onClick={() => openLinked(linked.url)}>
                <VerdictGlyph verdict={linkedVerdict} size={12} />
                <span className="grow">#{linked.number}</span>
                <span className={`end tone-${linkedVerdict.tone}`}>{linked.state === "OPEN" && linked.isDraft ? "Draft" : linked.state.toLowerCase()}</span>
              </button>
            );
          })
        ) : (
          <span className="tone-neutral">No linked pull request</span>
        )}
      </CardSection>
      <CardSection label="Labels">
        {issue.labels.length > 0 && (
          <div className="hub-card-line hub-card-wrap">
            {issue.labels.map((label) => (
              <span key={label} className="pr-inbox-label">
                {label}
              </span>
            ))}
          </div>
        )}
        {issue.milestone && (
          <div className="hub-card-line">
            <Milestone size={12} aria-hidden="true" className="tone-neutral" />
            <span className="grow">{issue.milestone}</span>
          </div>
        )}
        {issue.labels.length === 0 && !issue.milestone && <span className="tone-neutral">None</span>}
      </CardSection>
      <CardSection label="Activity">
        <div className="hub-card-line">
          <MessageSquare size={12} aria-hidden="true" className="tone-neutral" />
          <span className="grow">{issue.commentsCount} comments</span>
        </div>
        <div className="hub-card-line">
          <Clock size={12} aria-hidden="true" className="tone-neutral" />
          <span className="grow">updated {formatRelativeAge(issue.updatedAt, now)} ago</span>
        </div>
      </CardSection>
    </>
  );
}

type Job = WorkflowRunSummary["jobs"][number];

function jobDuration(job: Job, now: number): string {
  if (job.status === "queued") return "queued";
  if (job.startedAt === null) return "";
  return formatDuration((job.completedAt ?? now) - job.startedAt);
}

function JobGlyph({ job }: { job: Job }) {
  if (isJobFailed(job)) return <VerdictGlyph verdict={{ icon: "circle-x", tone: "bad" }} size={12} />;
  if (isJobSuccessful(job)) return <VerdictGlyph verdict={{ icon: "circle-check", tone: "ok" }} size={12} />;
  if (job.status === "in_progress") return <VerdictGlyph verdict={{ icon: "loader", tone: "warn", spin: true }} size={12} />;
  return <VerdictGlyph verdict={{ icon: "circle-dashed", tone: "neutral" }} size={12} />;
}

function JobLine({ job, now }: { job: Job; now: number }) {
  const url = job.url;
  const content = (
    <>
      <JobGlyph job={job} />
      <span className="grow">{job.name}</span>
      <span className="end">{jobDuration(job, now)}</span>
    </>
  );
  if (isJobFailed(job) && url !== null) {
    return (
      <button type="button" className="hub-card-line click" onClick={() => openExternalLink(url)}>
        {content}
      </button>
    );
  }
  return <div className="hub-card-line">{content}</div>;
}

function RunStatusCard({ run, now }: { run: WorkflowRunSummary; now: number }) {
  const duration = runDurationMs(run, now);
  return (
    <>
      <div className="hub-card-head">
        <Workflow size={13} aria-hidden="true" />
        {run.workflowName} #{run.runNumber}
        {run.branch && <span className="sub">{run.branch}</span>}
      </div>
      <CardSection label="Jobs">
        {run.jobs.length === 0 && <span className="tone-neutral">No jobs reported yet</span>}
        {run.jobs.map((job, index) => (
          <JobLine key={`${job.name}-${index}`} job={job} now={now} />
        ))}
      </CardSection>
      <CardSection label="Timing">
        <div className="hub-card-line">
          <Timer size={12} aria-hidden="true" className="tone-neutral" />
          <span className="grow">
            {duration === null ? "Not started" : formatDuration(duration)} · started {formatRelativeAge(run.createdAt, now)} ago
          </span>
        </div>
      </CardSection>
    </>
  );
}

export function StatusCard({ subject, viewer, now }: { subject: HoverSubject; viewer: string | null; now: number }) {
  if (subject.kind === "pr") return <PrStatusCard pr={subject.item} viewer={viewer} />;
  if (subject.kind === "issue") return <IssueStatusCard issue={subject.item} now={now} />;
  return <RunStatusCard run={subject.item} now={now} />;
}
