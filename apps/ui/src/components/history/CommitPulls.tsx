import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExternalLink, GitPullRequest, Maximize2, MessageSquare } from "lucide-react";
import type { HistoryCommitPull, HistoryCommitPulls, HistoryScope, PrCheck, PrRef } from "@cw-code/contracts";
import { COMMIT_PULLS_NO_GITHUB_REMOTE } from "@cw-code/shared/commitPulls";
import { prKey } from "@cw-code/shared/prRef";
import { useConnectionEpoch } from "../../server/topics.js";
import { usePrStore } from "../../stores/prStore.js";
import { mergeBoxState } from "../prDetailModel.js";
import { StatusRow, stateLabel } from "../PrSessionPanel.js";
import { acquirePrDetailWatch, usePrDetail } from "../usePrs.js";
import { errorMessage } from "../errorMessage.js";
import { openExternalLink } from "../externalLink.js";

const LOAD_DELAY_MS = 200;
const MAX_PIPS = 40;

interface CommitPullsState {
  result: HistoryCommitPulls | null;
  error: string;
  retry: () => void;
}

export function useCommitPulls(scope: HistoryScope, sha: string): CommitPullsState {
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

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="gg-note" role="status">
      {children}
    </div>
  );
}

export function RetryError({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  return (
    <div className="pr-view-error gg-error" role="alert">
      {children}
      <button type="button" className="pr-view-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function usePrRefDetail(ref: PrRef) {
  const key = prKey(ref);
  const entry = usePrDetail(key);
  const epoch = useConnectionEpoch();
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

  return { detail: entry?.detail ?? null, error: entry?.error ?? loadError, retry: () => setAttempt((value) => value + 1) };
}

export function CommitPrCard({ pull, linked }: { pull: HistoryCommitPull; linked: boolean }) {
  const ref = pull.ref;
  const openPr = usePrStore((s) => s.openPr);
  const { detail, error, retry } = usePrRefDetail(pull.ref);
  const status = useMemo(() => (detail ? mergeBoxState(detail) : null), [detail]);
  const unresolved = detail ? detail.threads.filter((thread) => !thread.isResolved).length : null;
  const title = detail?.title ?? pull.title;
  const state = stateLabel(detail ?? pull);
  const head = detail?.headRefName ?? pull.headRefName;
  const base = detail?.baseRefName ?? pull.baseRefName;

  return (
    <div className="gg-pr-card">
      <div className="gg-pr-card-title">
        <span className="gg-pr-card-text" title={title}>
          {title}
        </span>
        <span className="gg-pr-card-num">#{ref.number}</span>
      </div>
      <div className="gg-pr-card-meta">
        <span className={`pr-panel-state ${state.tone}`}>
          <GitPullRequest size={11} aria-hidden="true" />
          {state.label}
        </span>
        <span className="gg-pr-card-branch" title={head}>
          {head}
        </span>
        <span aria-hidden="true">→</span>
        <span className="gg-pr-card-branch" title={base}>
          {base}
        </span>
        {linked && <span className="gg-tag me">this session</span>}
      </div>
      {error && (
        <RetryError onRetry={retry}>
          Could not load #{ref.number}: {error}
        </RetryError>
      )}
      {!detail && !error && <Note>Loading pull request status…</Note>}
      {status && (
        <div className="gg-pr-card-status">
          <StatusRow row={status.review} />
          <StatusRow row={status.conflicts} />
        </div>
      )}
      {unresolved !== null && unresolved > 0 && (
        <div className="gg-pr-card-threads">
          <MessageSquare size={13} aria-hidden="true" />
          {`${unresolved} unresolved review ${unresolved === 1 ? "thread" : "threads"}`}
        </div>
      )}
      <div className="gg-actions">
        <button type="button" className="gg-action" onClick={() => openPr(ref)} title={`Open #${ref.number} in cw-code`}>
          <Maximize2 size={12} aria-hidden="true" />
          Open PR
        </button>
        <button type="button" className="gg-action" onClick={() => openExternalLink(pull.url)} title={`Open #${ref.number} on GitHub`}>
          <ExternalLink size={12} aria-hidden="true" />
          GitHub
        </button>
      </div>
    </div>
  );
}

function pipClass(check: PrCheck): string {
  if (check.status === "success") return "ok";
  if (check.status === "failure") return "bad";
  if (check.status === "pending") return "run";
  return "skip";
}

function PullChecks({ pull }: { pull: HistoryCommitPull }) {
  const entry = usePrDetail(prKey(pull.ref));
  const detail = entry?.detail ?? null;
  const openPr = usePrStore((s) => s.openPr);
  if (!detail && !entry?.error) return null;
  const header = (
    <h4 className="gg-d-h">
      Checks
      <span className="gg-d-h-aside">#{pull.ref.number}</span>
    </h4>
  );
  if (!detail) {
    return (
      <section className="gg-d-sec" aria-label="Checks">
        {header}
        <div className="gg-error-text" role="alert">
          Checks unavailable: {entry?.error}
        </div>
      </section>
    );
  }
  const ci = mergeBoxState(detail).ci;
  const runs = detail.checkRuns;
  return (
    <section className="gg-d-sec" aria-label="Checks">
      {header}
      <StatusRow row={ci} />
      {runs.length > 0 && (
        <div className="gg-pips" aria-hidden="true">
          {runs.slice(0, MAX_PIPS).map((check, index) => (
            <span key={`${check.name}:${index}`} className={`gg-pip ${pipClass(check)}`} title={`${check.name} — ${check.status}`} />
          ))}
        </div>
      )}
      {runs.length > 0 && (
        <button type="button" className="gg-link" onClick={() => openPr(pull.ref)}>
          Show all {runs.length} {runs.length === 1 ? "check" : "checks"}
        </button>
      )}
    </section>
  );
}

export function CommitPulls({ scope, sha, linkedKeys }: { scope: HistoryScope; sha: string; linkedKeys: ReadonlySet<string> }) {
  const { result, error, retry } = useCommitPulls(scope, sha);
  const pulls = result?.pulls ?? [];
  const first = pulls[0];

  let body: ReactNode;
  if (error) body = <RetryError onRetry={retry}>Could not look up pull requests: {error}</RetryError>;
  else if (!result) body = <Note>Looking up pull requests…</Note>;
  else if (result.unavailable === COMMIT_PULLS_NO_GITHUB_REMOTE) body = <Note>{result.unavailable}</Note>;
  else if (result.unavailable) body = <RetryError onRetry={retry}>{result.unavailable}</RetryError>;
  else if (!first) body = <Note>No pull request contains this commit.</Note>;
  else body = pulls.map((pull) => <CommitPrCard key={prKey(pull.ref)} pull={pull} linked={linkedKeys.has(prKey(pull.ref))} />);

  return (
    <>
      <section className="gg-d-sec" aria-label="Pull requests">
        <h4 className="gg-d-h">
          <GitPullRequest size={12} aria-hidden="true" />
          Pull requests
        </h4>
        {body}
      </section>
      {first && <PullChecks pull={first} />}
    </>
  );
}
