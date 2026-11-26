import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ExternalLink, GitPullRequest, Maximize2, MessageSquare } from "lucide-react";
import type { HistoryCommitPull, HistoryCommitPulls, HistoryScope } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { useConnectionEpoch } from "../../server/topics.js";
import { usePrStore } from "../../stores/prStore.js";
import { mergeBoxState } from "../prDetailModel.js";
import { PrSessionPanel, StatusRow, stateLabel, useSessionLinkedPrs } from "../PrSessionPanel.js";
import { acquirePrDetailWatch, usePrDetail } from "../usePrs.js";
import { errorMessage } from "../errorMessage.js";
import { openExternalLink } from "../externalLink.js";

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
          retryOnReconnect.current = next.unavailable !== null;
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

function CommitPrBody({ scope, sha }: { scope: HistoryScope; sha: string }) {
  const { result, error, retry } = useCommitPulls(scope, sha);
  const [chosen, setChosen] = useState<string | null>(null);

  if (error) return <RetryError onRetry={retry}>Could not look up pull requests: {error}</RetryError>;
  if (!result) return <Note>Looking up pull requests…</Note>;
  if (result.unavailable) return <RetryError onRetry={retry}>{result.unavailable}</RetryError>;
  const first = result.pulls[0];
  if (!first) return <Note>No pull request for this commit</Note>;
  const pull = result.pulls.find((candidate) => prKey(candidate.ref) === chosen) ?? first;
  const pullKey = prKey(pull.ref);

  return (
    <>
      {result.pulls.length > 1 && (
        <div className="pr-panel-switch git-glass-pr-switch" role="group" aria-label="Pull requests for this commit">
          {result.pulls.map((candidate) => {
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
    </>
  );
}

function SectionFrame({
  open,
  onToggle,
  aside,
  action,
  bodyClass,
  children
}: {
  open: boolean;
  onToggle: () => void;
  aside: string;
  action?: ReactNode;
  bodyClass?: string;
  children: ReactNode;
}) {
  const bodyId = useId();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="git-glass-pr" aria-label="Pull request">
      <div className="git-glass-pr-head">
        <button type="button" className="git-glass-pr-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <Chevron size={13} aria-hidden="true" />
          <GitPullRequest size={13} aria-hidden="true" />
          Pull request
          <span className="git-glass-pr-aside">{aside}</span>
        </button>
        {action}
      </div>
      {open && (
        <div id={bodyId} className={`git-glass-pr-body${bodyClass ? ` ${bodyClass}` : ""}`}>
          {children}
        </div>
      )}
    </section>
  );
}

function SessionPrSection({ sessionId, open, onToggle }: { sessionId: string; open: boolean; onToggle: () => void }) {
  const linked = useSessionLinkedPrs(sessionId);
  if (linked.length === 0) {
    return (
      <div className="git-glass-pr git-glass-pr-line" role="status">
        <GitPullRequest size={13} aria-hidden="true" />
        No pull request linked to this session
      </div>
    );
  }
  return (
    <SectionFrame open={open} onToggle={onToggle} aside="linked to this session">
      <PrSessionPanel sessionId={sessionId} />
    </SectionFrame>
  );
}

export function GitGlassPrSection({
  scope,
  sha,
  onShowSessionPr
}: {
  scope: HistoryScope;
  sha: string | null;
  onShowSessionPr: () => void;
}) {
  const [open, setOpen] = useState(true);
  const toggle = (): void => setOpen((value) => !value);
  const sessionId = "sessionId" in scope ? scope.sessionId : null;

  if (sha) {
    const action = sessionId ? (
      <button type="button" className="git-glass-pr-session" onClick={onShowSessionPr} title="Clear the commit selection (Esc)">
        Show this session's PR
      </button>
    ) : undefined;
    return (
      <SectionFrame open={open} onToggle={toggle} aside={`commit ${sha.slice(0, 7)}`} action={action} bodyClass="commit">
        <CommitPrBody key={sha} scope={scope} sha={sha} />
      </SectionFrame>
    );
  }
  if (sessionId) return <SessionPrSection sessionId={sessionId} open={open} onToggle={toggle} />;
  return null;
}
