import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ExternalLink, GitPullRequest, Maximize2, MessageSquare } from "lucide-react";
import type { HistoryCommitPull, HistoryCommitPulls, HistoryScope } from "@cw-code/contracts";
import { COMMIT_PULLS_NO_GITHUB_REMOTE } from "@cw-code/shared/commitPulls";
import { prKey } from "@cw-code/shared/prRef";
import { useConnectionEpoch } from "../../server/topics.js";
import { usePrStore } from "../../stores/prStore.js";
import { mergeBoxState } from "../prDetailModel.js";
import { PrSessionPanel, StatusRow, stateLabel, useSessionLinkedPrs } from "../PrSessionPanel.js";
import { acquirePrDetailWatch, usePrDetail } from "../usePrs.js";
import { errorMessage } from "../errorMessage.js";
import { openExternalLink } from "../externalLink.js";
import { branchPulls } from "./branchPulls.js";

const LOAD_DELAY_MS = 200;

interface CommitPullsState {
  result: HistoryCommitPulls | null;
  error: string;
  retry: () => void;
}

function useCommitPulls(scope: HistoryScope, sha: string): CommitPullsState {
  const [result, setResult] = useState<HistoryCommitPulls | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const retryOnReconnect = useRef(false);
  const epoch = useConnectionEpoch();

  useEffect(() => {
    if (retryOnReconnect.current) setAttempt((value) => value + 1);
  }, [epoch]);

  useEffect(() => {
    setResult(null);
    setError("");
    retryOnReconnect.current = false;
    let active = true;
    const timer = setTimeout(() => {
      window.cw.getHistoryCommitPulls(scope, sha).then(
        (next) => {
          if (!active) return;
          retryOnReconnect.current = next.unavailable !== null && next.unavailable !== COMMIT_PULLS_NO_GITHUB_REMOTE;
          setResult(next);
        },
        (reason: unknown) => {
          if (!active) return;
          retryOnReconnect.current = true;
          setError(errorMessage(reason));
        }
      );
    }, LOAD_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [scope, sha, attempt]);

  return { result, error, retry: () => setAttempt((value) => value + 1) };
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="git-glass-pr-note" role="status">
      {children}
    </div>
  );
}

function RetryError({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  return (
    <div className="pr-view-error git-glass-pr-error" role="alert">
      {children}
      <button type="button" className="pr-view-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function CommitPrCard({ pull }: { pull: HistoryCommitPull }) {
  const ref = pull.ref;
  const key = prKey(ref);
  const entry = usePrDetail(key);
  const epoch = useConnectionEpoch();
  const openPr = usePrStore((s) => s.openPr);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    window.cw.getPrDetail(ref).catch((reason: unknown) => {
      if (active) setLoadError(errorMessage(reason));
    });
    return () => {
      active = false;
    };
  }, [key, epoch, attempt]);

  useEffect(() => acquirePrDetailWatch(ref), [key]);

  const detail = entry?.detail ?? null;
  const status = useMemo(() => (detail ? mergeBoxState(detail) : null), [detail]);
  const unresolved = detail ? detail.threads.filter((thread) => !thread.isResolved).length : null;
  const error = entry?.error ?? loadError;
  const title = detail?.title ?? pull.title;
  const state = stateLabel(detail ?? pull);
  const head = detail?.headRefName ?? pull.headRefName;
  const base = detail?.baseRefName ?? pull.baseRefName;

  return (
    <div className="git-glass-pr-card">
      <div className="pr-panel-title-row">
        <div className="pr-panel-title" title={title}>
          <span className="pr-panel-num">#{ref.number}</span> {title}
        </div>
        <button type="button" className="pr-detail-btn sm" onClick={() => openPr(ref)} title={`Open #${ref.number} in cw-code`}>
          <Maximize2 size={12} aria-hidden="true" />
          Open PR
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => openExternalLink(pull.url)}
          title={`Open #${ref.number} on GitHub`}
          aria-label={`Open #${ref.number} on GitHub`}
        >
          <ExternalLink size={13} aria-hidden="true" />
        </button>
      </div>
      <div className="pr-panel-meta">
        <span className={`pr-panel-state ${state.tone}`}>
          <GitPullRequest size={11} aria-hidden="true" />
          {state.label}
        </span>
        <span className="pr-panel-branch" title={head}>{head}</span>
        <span aria-hidden="true">→</span>
        <span className="pr-panel-branch" title={base}>{base}</span>
      </div>
      {error && (
        <RetryError onRetry={() => setAttempt((value) => value + 1)}>
          Could not load #{ref.number}: {error}
        </RetryError>
      )}
      {!detail && !error && <Note>Loading pull request status…</Note>}
      {status && (
        <div className="git-glass-pr-status">
          <StatusRow row={status.ci} />
          <StatusRow row={status.review} />
          <StatusRow row={status.conflicts} />
        </div>
      )}
      {unresolved !== null && (
        <div className="git-glass-pr-threads">
          <MessageSquare size={13} aria-hidden="true" />
          {unresolved === 0 ? "No unresolved review threads" : `${unresolved} unresolved review ${unresolved === 1 ? "thread" : "threads"}`}
        </div>
      )}
    </div>
  );
}

const ALL_PULLS = (pulls: HistoryCommitPull[]): HistoryCommitPull[] => pulls;

type HeaderTone = "empty" | "error";

// One header row in every state. It only expands (chevron, button) when there is a pull request
// to show; otherwise the row itself carries the answer and stays collapsed.
function PrSectionView({
  summary,
  aside,
  tone,
  action,
  expandable,
  open,
  onToggle,
  bodyClass,
  children
}: {
  summary: ReactNode;
  aside: string;
  tone?: HeaderTone;
  action?: ReactNode;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
  bodyClass?: string;
  children?: ReactNode;
}) {
  const bodyId = useId();
  const shown = expandable && open;
  const Chevron = shown ? ChevronDown : ChevronRight;
  const content = (
    <>
      <span className="git-glass-pr-chevron" aria-hidden="true">
        {expandable && <Chevron size={14} />}
      </span>
      <GitPullRequest size={14} className="git-glass-pr-icon" aria-hidden="true" />
      <span className="git-glass-pr-label">Pull request</span>
      <span className="git-glass-pr-summary">{summary}</span>
      <span className="git-glass-pr-aside">{aside}</span>
    </>
  );
  return (
    <section className={`git-glass-pr${shown ? " open" : ""}`} aria-label="Pull request">
      <div className={`git-glass-pr-head${tone ? ` ${tone}` : ""}`}>
        {expandable ? (
          <button
            type="button"
            className="git-glass-pr-toggle"
            aria-expanded={shown}
            aria-controls={bodyId}
            title={shown ? "Hide the pull request details" : "Show the pull request details"}
            onClick={onToggle}
          >
            {content}
          </button>
        ) : (
          <div className="git-glass-pr-toggle static" role={tone === "error" ? "alert" : "status"}>
            {content}
          </div>
        )}
        {action}
      </div>
      {shown && (
        <div id={bodyId} className={`git-glass-pr-body${bodyClass ? ` ${bodyClass}` : ""}`}>
          {children}
        </div>
      )}
    </section>
  );
}

function PullSummary({ number, title, state, extra }: { number: number; title: string; state: { label: string; tone: string }; extra: number }) {
  return (
    <>
      <span className={`pr-panel-state ${state.tone}`}>{state.label}</span>
      <span className="git-glass-pr-summary-text" title={title}>
        <span className="pr-panel-num">#{number}</span> {title}
      </span>
      {extra > 0 && <span className="git-glass-pr-extra">+{extra}</span>}
    </>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <button type="button" className="git-glass-pr-session" onClick={onRetry}>
      Retry
    </button>
  );
}

function PullsSection({
  scope,
  sha,
  pick = ALL_PULLS,
  emptyText,
  groupLabel,
  aside,
  action,
  open,
  onToggle
}: {
  scope: HistoryScope;
  sha: string;
  pick?: (pulls: HistoryCommitPull[]) => HistoryCommitPull[];
  emptyText: string;
  groupLabel: string;
  aside: string;
  action?: ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  const { result, error, retry } = useCommitPulls(scope, sha);
  const [chosen, setChosen] = useState<string | null>(null);
  const pulls = useMemo(() => (result ? pick(result.pulls) : []), [result, pick]);
  const frame = { aside, open, onToggle, expandable: false } as const;
  const withRetry = (
    <>
      <RetryButton onRetry={retry} />
      {action}
    </>
  );

  if (error) return <PrSectionView {...frame} tone="error" action={withRetry} summary={`Could not look up pull requests: ${error}`} />;
  if (!result) return <PrSectionView {...frame} tone="empty" action={action} summary="Looking up pull requests…" />;
  if (result.unavailable === COMMIT_PULLS_NO_GITHUB_REMOTE) return <PrSectionView {...frame} tone="empty" action={action} summary={result.unavailable} />;
  if (result.unavailable) return <PrSectionView {...frame} tone="error" action={withRetry} summary={result.unavailable} />;
  const first = pulls[0];
  if (!first) return <PrSectionView {...frame} tone="empty" action={action} summary={emptyText} />;
  const pull = pulls.find((candidate) => prKey(candidate.ref) === chosen) ?? first;
  const pullKey = prKey(pull.ref);

  return (
    <PrSectionView
      {...frame}
      expandable
      action={action}
      bodyClass="commit"
      summary={<PullSummary number={pull.ref.number} title={pull.title} state={stateLabel(pull)} extra={pulls.length - 1} />}
    >
      {pulls.length > 1 && (
        <div className="pr-panel-switch git-glass-pr-switch" role="group" aria-label={groupLabel}>
          {pulls.map((candidate) => {
            const candidateKey = prKey(candidate.ref);
            const active = candidateKey === pullKey;
            const state = stateLabel(candidate);
            return (
              <button
                key={candidateKey}
                type="button"
                aria-pressed={active}
                className={`pr-panel-switch-btn${active ? " active" : ""}`}
                title={`#${candidate.ref.number} · ${candidate.title}`}
                onClick={() => setChosen(candidateKey)}
              >
                <span className={`pr-panel-state ${state.tone}`}>{state.label}</span>
                <span className="git-glass-pr-switch-num">#{candidate.ref.number}</span>
              </button>
            );
          })}
        </div>
      )}
      <CommitPrCard key={pullKey} pull={pull} />
    </PrSectionView>
  );
}

function SessionPrSection({ sessionId, open, onToggle }: { sessionId: string; open: boolean; onToggle: () => void }) {
  const linked = useSessionLinkedPrs(sessionId);
  const first = linked[0];
  if (!first) {
    return <PrSectionView aside="this session" tone="empty" expandable={false} open={open} onToggle={onToggle} summary="No pull request linked to this session" />;
  }
  const summary = first.title ? (
    <span className="git-glass-pr-summary-text" title={first.title}>
      <span className="pr-panel-num">#{first.ref.number}</span> {first.title}
      {linked.length > 1 && <span className="git-glass-pr-extra">+{linked.length - 1}</span>}
    </span>
  ) : (
    <span className="git-glass-pr-summary-text">
      <span className="pr-panel-num">#{first.ref.number}</span>
    </span>
  );
  return (
    <PrSectionView aside="linked to this session" expandable open={open} onToggle={onToggle} summary={summary}>
      <PrSessionPanel sessionId={sessionId} />
    </PrSectionView>
  );
}

function BranchPrSection({
  scope,
  target,
  open,
  onToggle
}: {
  scope: HistoryScope;
  target: Extract<GitGlassPrTarget, { kind: "branch" }>;
  open: boolean;
  onToggle: () => void;
}) {
  const { branch, sha, upstream } = target;
  const pick = useCallback((pulls: HistoryCommitPull[]) => (branch ? branchPulls(pulls, branch, upstream) : []), [branch, upstream]);
  if (!branch) {
    return (
      <PrSectionView aside="detached HEAD" tone="empty" expandable={false} open={open} onToggle={onToggle} summary="Select a commit to see its pull requests" />
    );
  }
  if (!sha) {
    return <PrSectionView aside={`branch ${branch}`} tone="empty" expandable={false} open={open} onToggle={onToggle} summary={`No commits on ${branch} yet`} />;
  }
  return (
    <PullsSection
      key={`${branch}@${sha}`}
      scope={scope}
      sha={sha}
      pick={pick}
      emptyText={`No pull request for ${branch}`}
      groupLabel={`Pull requests for ${branch}`}
      aside={`branch ${branch}`}
      open={open}
      onToggle={onToggle}
    />
  );
}

// What the PR section describes when no commit is selected: the session's linked PR on the
// session's own checkout, the checked-out branch's PR on any other checkout.
export type GitGlassPrTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "branch"; branch: string | null; sha: string | null; upstream: string | null }
  | { kind: "loading" };

export function GitGlassPrSection({
  scope,
  sha,
  target,
  onClearSelection
}: {
  scope: HistoryScope;
  sha: string | null;
  target: GitGlassPrTarget;
  onClearSelection: () => void;
}) {
  // Kept across commits, so collapsing the details stays collapsed while browsing.
  const [open, setOpen] = useState(true);
  const toggle = (): void => setOpen((value) => !value);

  if (sha) {
    const label =
      target.kind === "session" ? "Show this session's PR" : target.kind === "branch" && target.branch ? `Show ${target.branch}'s PR` : null;
    const action = label ? (
      <button type="button" className="git-glass-pr-session" onClick={onClearSelection} title="Clear the commit selection (Esc)">
        {label}
      </button>
    ) : undefined;
    return (
      <PullsSection
        key={sha}
        scope={scope}
        sha={sha}
        emptyText="No pull request for this commit"
        groupLabel="Pull requests for this commit"
        aside={`commit ${sha.slice(0, 7)}`}
        action={action}
        open={open}
        onToggle={toggle}
      />
    );
  }
  if (target.kind === "session") return <SessionPrSection sessionId={target.sessionId} open={open} onToggle={toggle} />;
  if (target.kind === "branch") return <BranchPrSection scope={scope} target={target} open={open} onToggle={toggle} />;
  return null;
}
