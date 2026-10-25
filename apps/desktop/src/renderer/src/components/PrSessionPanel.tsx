import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, CircleX, ExternalLink, GitPullRequest, History, Link2, MessageSquare, RefreshCw, Send, Unlink } from "lucide-react";
import type { PrDetail, PrReviewThread } from "../cw.js";
import { usePrStore } from "../stores/prStore.js";
import { PrChipBadge } from "./PrChipBadge.js";
import { mergeBoxState, threadQuoteText, type MergeRow } from "./prDetailModel.js";
import { prKey } from "./prInbox.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { whyLinkedText } from "./babysitLabels.js";
import { defaultFollowUpWorkflowId, followUpWorkflow } from "./prWorkflows.js";
import { updatesSince } from "./prUpdates.js";
import { PrUpdateIcon } from "./PrUpdateIcon.js";
import { PrPanelSkeleton } from "./GitHubSkeletons.js";
import { useBranchMismatch, useGitStatus } from "./useGit.js";
import { canLinkItem, sessionPrItemLabel, sessionPrItemsTitle, type SessionPrItem } from "./sessionPrItems.js";
import { displayChip, mostUrgentLink, prRefLabel } from "./sessionPrLinks.js";
import { useLinkedPrs, useSessionPrItems } from "./useLinkedPr.js";
import { requestPrDetail } from "./usePrs.js";
import { useAppSettings, useAppSettingsError } from "./useAppSettings.js";
import { useNotifs } from "./Notifications.js";
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

function useSelectedLinkedPr(sessionId: string) {
  const linked = useLinkedPrs(sessionId);
  const selectedKey = usePrStore((s) => s.selectedPrKeyBySession[sessionId] ?? null);
  const gitStatus = useGitStatus(sessionId);
  const mismatch = useBranchMismatch(sessionId);
  const gitPr = mismatch ? null : (gitStatus?.pullRequest ?? null);
  const links = useMemo(() => linked.items.map((item) => item.link), [linked.items]);
  const urgent = useMemo(() => mostUrgentLink(links, linked.summaryByKey, gitPr), [links, linked.summaryByKey, gitPr]);
  const urgentKey = urgent ? prKey(urgent.ref) : null;
  const selected =
    linked.items.find((item) => item.key === selectedKey) ?? linked.items.find((item) => item.key === urgentKey) ?? linked.items[0];
  return { items: linked.items, summaryByKey: linked.summaryByKey, gitPr, selected };
}

function PrMenuRow({
  item,
  linking,
  onOpen,
  onLink
}: {
  item: SessionPrItem;
  linking: boolean;
  onOpen: () => void;
  onLink: () => void;
}) {
  const label = sessionPrItemLabel(item);
  const number = item.ref.number;
  return (
    <div className="pr-links-row" role="listitem" title={label}>
      <span className={`pr-links-source ${item.source}`}>{item.source}</span>
      <PrChipBadge chip={item.chip} />
      <span className="name">{item.title ?? `Pull request #${number}`}</span>
      {item.unseen && <span className="pr-panel-chip-dot" aria-hidden="true" />}
      {canLinkItem(item) && (
        <button
          type="button"
          className="pr-links-action"
          disabled={linking}
          aria-label={`Link pull request #${number} to this session`}
          onClick={onLink}
        >
          <Link2 size={11} aria-hidden="true" />
          Link to this session
        </button>
      )}
      <button type="button" className="pr-links-action" aria-label={`Open pull request #${number}`} onClick={onOpen}>
        Open
      </button>
    </div>
  );
}

export function PrSessionChip({ sessionId }: { sessionId: string }) {
  const { items } = useSessionPrItems(sessionId);
  const openPr = usePrStore((s) => s.openPr);
  const selectedKey = usePrStore((s) => s.selectedPrKeyBySession[sessionId] ?? null);
  const selectSessionPr = usePrStore((s) => s.selectSessionPr);
  const chipRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [linkingKey, setLinkingKey] = useState<string | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const updateCount = useMemo(() => {
    let total: number | null = null;
    for (const item of items) {
      if (item.detail && item.link) total = (total ?? 0) + updatesSince(item.detail, item.link).length;
    }
    return total;
  }, [items]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.focus();
    const closeOnOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [menuOpen]);

  useEffect(() => {
    if (selectedKey !== null && items.length > 0 && !items.some((item) => item.key === selectedKey)) selectSessionPr(sessionId, null);
  }, [items, selectedKey, sessionId, selectSessionPr]);

  const top = items[0];
  if (!top) return null;
  const multiple = items.length > 1;
  const showDot = updateCount === null && items.some((item) => item.unseen);
  const title = [
    multiple ? sessionPrItemsTitle(items) : top.chip.title,
    updateCount ? `${updateCount} ${updateCount === 1 ? "update" : "updates"} since your last turn` : null,
    showDot ? "Updated since your last turn" : null,
    multiple ? "Choose a pull request" : "Open the pull request"
  ]
    .filter(Boolean)
    .join(" · ");

  const open = (item: SessionPrItem) => {
    setMenuOpen(false);
    selectSessionPr(sessionId, item.key);
    openPr(item.ref);
  };

  const linkToSession = async (item: SessionPrItem) => {
    if (linkingKey !== null) return;
    setLinkingKey(item.key);
    try {
      await window.cw.linkSessionPr(sessionId, { ref: item.ref, origin: "linked", lastSeenSha: item.headSha, lastSeenAt: Date.now() });
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title: `Could not link #${item.ref.number}`, message: errorMessage(err) });
    } finally {
      setLinkingKey(null);
    }
  };

  return (
    <span className="pr-panel-chip-wrap" ref={wrapRef}>
      <button
        ref={chipRef}
        type="button"
        className="pr-panel-chip"
        onClick={() => (multiple ? setMenuOpen((value) => !value) : open(top))}
        title={title}
        aria-label={title}
        aria-expanded={multiple ? menuOpen : undefined}
      >
        <PrChipBadge chip={top.chip} extra={items.length - 1} title={title} />
        {updateCount !== null && updateCount > 0 && <span className="pr-panel-chip-count">{updateCount}</span>}
        {showDot && <span className="pr-panel-chip-dot" aria-hidden="true" />}
      </button>
      {multiple && menuOpen && (
        <div
          ref={menuRef}
          className="menu-panel menu-panel-down pr-links-menu"
          role="list"
          aria-label="Pull requests for this session"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            setMenuOpen(false);
            chipRef.current?.focus();
          }}
        >
          {items.map((item) => (
            <PrMenuRow
              key={item.key}
              item={item}
              linking={linkingKey !== null}
              onOpen={() => open(item)}
              onLink={() => void linkToSession(item)}
            />
          ))}
        </div>
      )}
    </span>
  );
}

export function PrSessionPanel({ sessionId }: { sessionId: string }) {
  const { items, summaryByKey, gitPr, selected } = useSelectedLinkedPr(sessionId);
  const selectSessionPr = usePrStore((s) => s.selectSessionPr);
  const link = selected?.link;
  const summary = selected?.summary;
  const detail = selected?.detail;
  const loading = selected?.loading ?? false;
  const error = selected?.error;
  const openPr = usePrStore((s) => s.openPr);
  const openRunModal = usePrStore((s) => s.openRunModal);
  const settings = useAppSettings();
  const settingsError = useAppSettingsError();
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
    openRunModal({ workflowId, subject: { kind: "pr", ref: link.ref }, continueSessionId: sessionId, promptOverride: threadQuoteText(thread, link.ref) });
  };

  const unlink = async () => {
    if (unlinking) return;
    setUnlinking(true);
    setActionError(null);
    try {
      await window.cw.unlinkSessionPr(sessionId, link.ref);
      selectSessionPr(sessionId, null);
    } catch (err) {
      setActionError(`Could not unlink #${link.ref.number}: ${errorMessage(err)}`);
    } finally {
      setUnlinking(false);
    }
  };

  const state = pr ? stateLabel(pr) : null;

  return (
    <div className="pr-panel">
      {items.length > 1 && (
        <div className="pr-panel-switch" role="tablist" aria-label="Linked pull requests">
          {items.map((item) => {
            const itemPr = item.summary ?? item.detail;
            const active = item.key === selected?.key;
            return (
              <button
                key={item.key}
                className={`pr-panel-switch-btn${active ? " active" : ""}`}
                role="tab"
                aria-selected={active}
                title={itemPr ? `${prRefLabel(item.link.ref)} · ${itemPr.title}` : prRefLabel(item.link.ref)}
                onClick={() => {
                  selectSessionPr(sessionId, item.key);
                  setActionError(null);
                }}
              >
                <PrChipBadge chip={displayChip(item.link, summaryByKey, gitPr)} />
                {item.unseen && <span className="pr-panel-chip-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
      <div className="pr-panel-head">
        <div className="pr-panel-title-row">
          <div className="pr-panel-title" title={pr?.title}>
            {pr?.title ?? `Pull request #${link.ref.number}`} <span className="pr-panel-num">#{link.ref.number}</span>
          </div>
          <button
            className="icon-btn"
            onClick={() => void requestPrDetail(link.ref)}
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
            <button className="pr-view-retry" onClick={() => void requestPrDetail(link.ref)} disabled={loading}>
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
        {!detail && loading && <PrPanelSkeleton />}
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
