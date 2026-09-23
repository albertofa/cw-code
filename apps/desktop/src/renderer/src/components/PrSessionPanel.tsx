import { useMemo, useState } from "react";
import { CircleCheck, CircleX, ExternalLink, GitPullRequest, History, Link2, MessageSquare, RefreshCw, Send, Unlink } from "lucide-react";
import type { PrDetail, PrReviewThread } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { prChip } from "./prChip.js";
import { PrChipBadge } from "./PrChipBadge.js";
import { mergeBoxState, threadQuoteText, type MergeRow } from "./prDetailModel.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { defaultFollowUpWorkflowId, followUpWorkflow, whyLinkedText } from "./prSessionModel.js";
import { updatesSince } from "./prUpdates.js";
import { PrUpdateIcon } from "./PrUpdateIcon.js";
import { useLinkedPr, usePrSettings } from "./useLinkedPr.js";
import { errorMessage } from "./errorMessage.js";

function stateLabel(pr: Pick<PrDetail, "state" | "isDraft">): { label: string; tone: string } {
  if (pr.state === "MERGED") return { label: "Merged", tone: "merged" };
  if (pr.state === "CLOSED") return { label: "Closed", tone: "closed" };
  if (pr.isDraft) return { label: "Draft", tone: "draft" };
  return { label: "Open", tone: "open" };
}

function StatusRow({ row }: { row: MergeRow }) {
  const Icon = row.ok ? CircleCheck : CircleX;
  return (
    <div className="pr-panel-status-row">
      <Icon size={13} className={`pr-panel-status-icon${row.ok ? " ok" : " bad"}`} aria-hidden="true" />
      <span className="pr-panel-status-label">{row.label}</span>
      {row.detail && <span className="pr-panel-status-detail">{row.detail}</span>}
    </div>
  );
}

function ThreadRow({ thread, onSend }: { thread: PrReviewThread; onSend: () => void }) {
  const first = thread.comments[0];
  const location = thread.line !== null ? `${thread.path}:${thread.line}` : thread.path;
  return (
    <div className="pr-panel-thread">
      <div className="pr-panel-thread-text">
        <div className="pr-panel-thread-loc" title={location}>{location}</div>
        {first && (
          <div className="pr-panel-thread-body">
            <b>{first.author}</b> {first.body}
          </div>
        )}
      </div>
      <button className="icon-btn pr-panel-thread-send" onClick={onSend} title="Send to chat" aria-label={`Send ${location} to chat`}>
        <Send size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

export function PrSessionChip({ sessionId }: { sessionId: string }) {
  const { link, summary, detail, unseen } = useLinkedPr(sessionId);
  const gitPr = useAppStore((s) => s.gitStatusBySession[sessionId]?.pullRequest ?? null);
  const openPr = usePrStore((s) => s.openPr);
  const updateCount = useMemo(() => (detail && link ? updatesSince(detail, link).length : null), [detail, link]);

  if (!link) return null;
  const git = gitPr && gitPr.number === link.ref.number ? gitPr : null;
  const chip = prChip({ pr: summary ?? detail ?? null, git });
  const showDot = updateCount === null && unseen;
  const title = [
    chip?.title ?? `PR #${link.ref.number}`,
    updateCount ? `${updateCount} ${updateCount === 1 ? "update" : "updates"} since your last turn` : null,
    showDot ? "Updated since your last turn" : null,
    "Open the pull request"
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button className="pr-panel-chip" onClick={() => openPr(link.ref)} title={title} aria-label={title}>
      {chip ? (
        <PrChipBadge chip={chip} />
      ) : (
        <span className="pr-chip">
          <GitPullRequest size={11} aria-hidden="true" />#{link.ref.number}
        </span>
      )}
      {updateCount !== null && updateCount > 0 && <span className="pr-panel-chip-count">{updateCount}</span>}
      {showDot && <span className="pr-panel-chip-dot" aria-hidden="true" />}
    </button>
  );
}

export function PrSessionPanel({ sessionId }: { sessionId: string }) {
  const { link, summary, detail, loading, error } = useLinkedPr(sessionId);
  const applySession = useAppStore((s) => s.applySession);
  const openPr = usePrStore((s) => s.openPr);
  const openRunModal = usePrStore((s) => s.openRunModal);
  const loadDetail = usePrStore((s) => s.loadDetail);
  const { settings, error: settingsError } = usePrSettings();
  const [unlinking, setUnlinking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const updates = useMemo(() => (detail && link ? updatesSince(detail, link) : []), [detail, link]);
  const unresolved = useMemo(() => (detail ? detail.threads.filter((t) => !t.isResolved) : []), [detail]);
  const status = useMemo(() => (detail ? mergeBoxState(detail) : null), [detail]);

  if (!link) {
    return <div className="right-empty">This session isn't linked to a pull request.</div>;
  }

  const pr = detail ?? summary ?? null;
  const workflows = settings?.prWorkflows ?? [];
  const workflowId = followUpWorkflow(link, pr, workflows)?.id ?? defaultFollowUpWorkflowId(link, pr);
  const now = Date.now();

  const sendThread = (thread: PrReviewThread) => {
    openRunModal({ workflowId, ref: link.ref, continueSessionId: sessionId, promptOverride: threadQuoteText(thread, link.ref) });
  };

  const unlink = async () => {
    if (unlinking) return;
    setUnlinking(true);
    setActionError(null);
    try {
      applySession(await window.cw.unlinkSessionPr(sessionId));
    } catch (err) {
      setActionError(`Could not unlink: ${errorMessage(err)}`);
    } finally {
      setUnlinking(false);
    }
  };

  const state = pr ? stateLabel(pr) : null;

  return (
    <div className="pr-panel">
      <div className="pr-panel-head">
        <div className="pr-panel-title-row">
          <div className="pr-panel-title" title={pr?.title}>
            {pr?.title ?? `Pull request #${link.ref.number}`} <span className="pr-panel-num">#{link.ref.number}</span>
          </div>
          <button
            className="icon-btn"
            onClick={() => void loadDetail(link.ref)}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh pull request"
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <button className="icon-btn" onClick={() => openPr(link.ref)} title="Open full view" aria-label="Open full PR view">
            <ExternalLink size={14} aria-hidden="true" />
          </button>
        </div>
        {pr && state && (
          <div className="pr-panel-meta">
            <span className={`pr-panel-state ${state.tone}`}>
              <GitPullRequest size={11} aria-hidden="true" />
              {state.label}
            </span>
            <span className="pr-panel-branch" title={pr.headRefName}>{pr.headRefName}</span>
            <span aria-hidden="true">→</span>
            <span className="pr-panel-branch" title={pr.baseRefName}>{pr.baseRefName}</span>
            <span className="pr-panel-add">+{pr.additions}</span>
            <span className="pr-panel-del">−{pr.deletions}</span>
          </div>
        )}
      </div>
      <div className="pr-panel-body">
        {error && (
          <div className="pr-view-error" role="alert">
            {error}
            <button className="pr-view-retry" onClick={() => void loadDetail(link.ref)} disabled={loading}>
              Retry
            </button>
          </div>
        )}
        {settingsError && (
          <div className="pr-view-error" role="alert">
            Could not load workflows: {settingsError}
          </div>
        )}
        {actionError && (
          <div className="pr-view-error" role="alert">
            {actionError}
          </div>
        )}
        {!detail && loading && <div className="pr-panel-empty">Loading pull request…</div>}
        {detail && (
          <>
            <section className="pr-panel-sec">
              <h4 className="pr-panel-sec-head">
                <History size={13} aria-hidden="true" />
                What's new since last turn
                {link.lastSeenSha && (
                  <span className="pr-panel-sec-aside">
                    last saw <code>{link.lastSeenSha.slice(0, 7)}</code>
                  </span>
                )}
              </h4>
              {updates.length === 0 ? (
                <div className="pr-panel-empty">Nothing new.</div>
              ) : (
                <ul className="pr-panel-updates">
                  {updates.map((update, index) => (
                    <li key={`${update.kind}-${update.at}-${index}`} className="pr-panel-update">
                      <PrUpdateIcon kind={update.kind} />
                      <span className="pr-panel-update-text">{update.summary}</span>
                      <span className="pr-panel-update-age">{formatRelativeAge(update.at, now)} ago</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {status && (
              <section className="pr-panel-sec">
                <h4 className="pr-panel-sec-head">Status</h4>
                <StatusRow row={status.ci} />
                <StatusRow row={status.review} />
                <StatusRow row={status.conflicts} />
              </section>
            )}
            {unresolved.length > 0 && (
              <section className="pr-panel-sec">
                <h4 className="pr-panel-sec-head">
                  <MessageSquare size={13} aria-hidden="true" />
                  Unresolved threads · {unresolved.length}
                </h4>
                {unresolved.map((thread) => (
                  <ThreadRow key={thread.id} thread={thread} onSend={() => sendThread(thread)} />
                ))}
              </section>
            )}
          </>
        )}
        <section className="pr-panel-sec">
          <h4 className="pr-panel-sec-head">
            <Link2 size={13} aria-hidden="true" />
            Why this session is linked
          </h4>
          <div className="pr-panel-why">{whyLinkedText(link, pr, workflows)}</div>
          <div className="pr-panel-actions">
            <button className="pr-detail-btn sm" onClick={() => openPr(link.ref)}>
              <ExternalLink size={12} aria-hidden="true" />
              Open full view
            </button>
            <button className="pr-detail-btn ghost sm" onClick={() => void unlink()} disabled={unlinking}>
              <Unlink size={12} aria-hidden="true" />
              Unlink
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
