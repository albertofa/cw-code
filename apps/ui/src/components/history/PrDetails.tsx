import { useEffect, useMemo, useState } from "react";
import { ExternalLink, GitPullRequest, Link2, Maximize2, MessageSquare, MessagesSquare } from "lucide-react";
import { prRefUrl } from "@cw-code/shared/prRef";
import { usePrStore } from "../../stores/prStore.js";
import { mergeBoxState } from "../prDetailModel.js";
import { PrSessionPanel, StatusRow, stateLabel } from "../PrSessionPanel.js";
import { openExternalLink } from "../externalLink.js";
import { errorMessage } from "../errorMessage.js";
import { Note, RetryError, usePrRefDetail } from "./CommitPulls.js";
import type { SidebarPr } from "./sidebarModel.js";

function LinkedPr({ sessionId, prKey }: { sessionId: string; prKey: string }) {
  const selectSessionPr = usePrStore((s) => s.selectSessionPr);
  useEffect(() => {
    selectSessionPr(sessionId, prKey);
  }, [sessionId, prKey, selectSessionPr]);
  return (
    <div className="gg-pr-linked">
      <PrSessionPanel sessionId={sessionId} />
    </div>
  );
}

function ReadOnlyPr({ pr, sessionId, onOpenSession }: { pr: SidebarPr; sessionId: string | null; onOpenSession: (sessionId: string) => void }) {
  const ref = pr.ref;
  const openPr = usePrStore((s) => s.openPr);
  const { detail, error, retry } = usePrRefDetail(ref);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState("");
  const status = useMemo(() => (detail ? mergeBoxState(detail) : null), [detail]);

  const title = detail?.title ?? pr.title ?? `Pull request #${ref.number}`;
  const stateSource = detail ?? (pr.state ? { state: pr.state, isDraft: pr.isDraft } : null);
  const state = stateSource ? stateLabel(stateSource) : null;
  const head = detail?.headRefName ?? pr.headRefName;
  const url = detail?.url ?? pr.url ?? prRefUrl(ref);
  const headSha = detail?.headRefOid ?? pr.headRefOid;
  const unresolved = detail ? detail.threads.filter((thread) => !thread.isResolved).length : null;
  const linkedElsewhere = pr.sessionId !== null && !pr.linkedHere ? pr.sessionId : null;

  const link = (): void => {
    if (!sessionId || !headSha || linking) return;
    setLinking(true);
    setLinkError("");
    window.cw
      .linkSessionPr(sessionId, { ref, origin: "linked", lastSeenSha: headSha, lastSeenAt: Date.now() })
      .catch((reason: unknown) => setLinkError(`Could not link #${ref.number}: ${errorMessage(reason)}`))
      .finally(() => setLinking(false));
  };

  return (
    <div className="gg-pr-details">
      <h2 className="gg-d-title">
        {title} <span className="gg-d-title-num">#{ref.number}</span>
      </h2>
      <div className="gg-pr-card-meta">
        {state && (
          <span className={`pr-panel-state ${state.tone}`}>
            <GitPullRequest size={11} aria-hidden="true" />
            {state.label}
          </span>
        )}
        {head && (
          <span className="gg-pr-card-branch" title={head}>
            {head}
          </span>
        )}
        {detail && (
          <>
            <span aria-hidden="true">→</span>
            <span className="gg-pr-card-branch" title={detail.baseRefName}>
              {detail.baseRefName}
            </span>
            <span className="gg-add">+{detail.additions}</span>
            <span className="gg-del">−{detail.deletions}</span>
          </>
        )}
      </div>

      <section className="gg-d-sec" aria-label="Status">
        <h4 className="gg-d-h">Status</h4>
        {error && (
          <RetryError onRetry={retry}>
            Could not load #{ref.number}: {error}
          </RetryError>
        )}
        {!detail && !error && <Note>Loading pull request status…</Note>}
        {status && (
          <div className="gg-pr-card-status">
            <StatusRow row={status.ci} />
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
      </section>

      <section className="gg-d-sec" aria-label="Session">
        <h4 className="gg-d-h">Session</h4>
        <div className="gg-note">
          {linkedElsewhere ? <>Linked to “{pr.sessionTitle ?? "another session"}”.</> : "Not linked to any session."}
        </div>
        <div className="gg-actions gg-actions-spaced">
          {linkedElsewhere && (
            <button type="button" className="gg-action primary" onClick={() => onOpenSession(linkedElsewhere)}>
              <MessagesSquare size={12} aria-hidden="true" />
              Open that session
            </button>
          )}
          {!linkedElsewhere && sessionId && (
            <button
              type="button"
              className="gg-action primary"
              aria-disabled={!headSha || linking ? "true" : undefined}
              title={!headSha ? "Waiting for the pull request to load" : linking ? "Linking…" : `Link #${ref.number} to this session`}
              onClick={link}
            >
              <Link2 size={12} aria-hidden="true" />
              {linking ? "Linking…" : "Link to this session"}
            </button>
          )}
          <button type="button" className="gg-action" onClick={() => openPr(ref)} title={`Open #${ref.number} in cw-code`}>
            <Maximize2 size={12} aria-hidden="true" />
            Full PR view
          </button>
          <button type="button" className="gg-action" onClick={() => openExternalLink(url)} title={`Open #${ref.number} on GitHub`}>
            <ExternalLink size={12} aria-hidden="true" />
            GitHub
          </button>
        </div>
        {linkError && <div className="gg-error-text">{linkError}</div>}
      </section>
    </div>
  );
}

export function PrDetails({ pr, sessionId, onOpenSession }: { pr: SidebarPr; sessionId: string | null; onOpenSession: (sessionId: string) => void }) {
  if (pr.linkedHere && sessionId) return <LinkedPr sessionId={sessionId} prKey={pr.key} />;
  return <ReadOnlyPr key={pr.key} pr={pr} sessionId={sessionId} onOpenSession={onOpenSession} />;
}
