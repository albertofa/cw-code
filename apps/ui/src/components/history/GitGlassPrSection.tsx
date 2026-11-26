import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ExternalLink, GitPullRequest, MessageSquare } from "lucide-react";
import type { HistoryCommitPull, HistoryCommitPulls, HistoryScope } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { useConnectionEpoch } from "../../server/topics.js";
import { usePrStore } from "../../stores/prStore.js";
import { mergeBoxState } from "../prDetailModel.js";
import { PrSessionPanel, StatusRow, stateLabel, useSessionLinkedPrs } from "../PrSessionPanel.js";
import { usePrDetail, watchPrDetail } from "../usePrs.js";
import { errorMessage } from "../errorMessage.js";

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
  const failed = useRef(false);
  const epoch = useConnectionEpoch();

  useEffect(() => {
    if (failed.current) setAttempt((value) => value + 1);
  }, [epoch]);

  useEffect(() => {
    setResult(null);
    setError("");
    failed.current = false;
    let active = true;
    const timer = setTimeout(() => {
      window.cw.getHistoryCommitPulls(scope, sha).then(
        (next) => {
          if (active) setResult(next);
        },
        (reason: unknown) => {
          if (!active) return;
          failed.current = true;
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

function Note({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <div className={`git-glass-pr-note${alert ? " error" : ""}`} role={alert ? "alert" : undefined}>
      {children}
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

  useEffect(() => watchPrDetail(ref), [key, epoch]);

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
        <button type="button" className="pr-detail-btn sm" onClick={() => openPr(ref)} title={pull.url}>
          <ExternalLink size={12} aria-hidden="true" />
          Open PR
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
        <div className="pr-view-error git-glass-pr-error" role="alert">
          Could not load #{ref.number}: {error}
          <button type="button" className="pr-view-retry" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </div>
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

  if (error) {
    return (
      <div className="pr-view-error git-glass-pr-error" role="alert">
        Could not look up pull requests: {error}
        <button type="button" className="pr-view-retry" onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  if (!result) return <Note>Looking up pull requests…</Note>;
  if (result.unavailable) return <Note>{result.unavailable}</Note>;
  const first = result.pulls[0];
  if (!first) return <Note>No pull request for this commit</Note>;
  const pull = result.pulls.find((candidate) => prKey(candidate.ref) === chosen) ?? first;
  const pullKey = prKey(pull.ref);

  return (
    <>
      {result.pulls.length > 1 && (
        <div className="pr-panel-switch git-glass-pr-switch" role="tablist" aria-label="Pull requests for this commit">
          {result.pulls.map((candidate) => {
            const candidateKey = prKey(candidate.ref);
            const active = candidateKey === pullKey;
            const state = stateLabel(candidate);
            return (
              <button
                key={candidateKey}
                type="button"
                role="tab"
                aria-selected={active}
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

function SessionPrBody({ sessionId }: { sessionId: string }) {
  const linked = useSessionLinkedPrs(sessionId);
  if (linked.length === 0) return <Note>No pull request linked to this session</Note>;
  return <PrSessionPanel sessionId={sessionId} />;
}

export function GitGlassPrSection({ scope, sha }: { scope: HistoryScope; sha: string | null }) {
  const [open, setOpen] = useState(true);
  const sessionId = "sessionId" in scope ? scope.sessionId : null;
  if (!sha && !sessionId) return null;
  const aside = sha ? `commit ${sha.slice(0, 7)}` : "linked to this session";
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <section className="git-glass-pr" aria-label="Pull request">
      <button type="button" className="git-glass-pr-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Chevron size={13} aria-hidden="true" />
        <GitPullRequest size={13} aria-hidden="true" />
        Pull request
        <span className="git-glass-pr-aside">{aside}</span>
      </button>
      {open && (
        <div className="git-glass-pr-body">
          {sha ? <CommitPrBody key={sha} scope={scope} sha={sha} /> : sessionId ? <SessionPrBody sessionId={sessionId} /> : null}
        </div>
      )}
    </section>
  );
}
