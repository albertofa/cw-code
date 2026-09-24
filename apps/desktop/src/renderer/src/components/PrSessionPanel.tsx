import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, CircleX, ExternalLink, GitPullRequest, History, Link2, MessageSquare, RefreshCw, Send, Unlink } from "lucide-react";
import type { PrDetail, PrReviewThread } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { PrChipBadge } from "./PrChipBadge.js";
import { mergeBoxState, threadQuoteText, type MergeRow } from "./prDetailModel.js";
import { prKey } from "./prInbox.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { defaultFollowUpWorkflowId, followUpWorkflow, whyLinkedText } from "./prSessionModel.js";
import { updatesSince } from "./prUpdates.js";
import { PrUpdateIcon } from "./PrUpdateIcon.js";
import { displayChip, linksTitle, mostUrgentLink, prRefLabel } from "./sessionPrLinks.js";
import { useLinkedPrs, usePrSettings } from "./useLinkedPr.js";
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

function useSelectedLinkedPr(sessionId: string, selectedKey: string | null) {
  const linked = useLinkedPrs(sessionId);
  const gitPr = useAppStore((s) => s.gitStatusBySession[sessionId]?.pullRequest ?? null);
  const links = useMemo(() => linked.items.map((item) => item.link), [linked.items]);
  const urgent = useMemo(() => mostUrgentLink(links, linked.summaryByKey, gitPr), [links, linked.summaryByKey, gitPr]);
  const urgentKey = urgent ? prKey(urgent.ref) : null;
  const selected =
    linked.items.find((item) => item.key === selectedKey) ?? linked.items.find((item) => item.key === urgentKey) ?? linked.items[0];
  return { items: linked.items, summaryByKey: linked.summaryByKey, links, gitPr, selected };
}

export function PrSessionChip({ sessionId }: { sessionId: string }) {
  const { items, links, summaryByKey, gitPr, selected } = useSelectedLinkedPr(sessionId, null);
  const openPr = usePrStore((s) => s.openPr);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const updateCount = useMemo(() => {
    let total: number | null = null;
    for (const item of items) {
      if (item.detail) total = (total ?? 0) + updatesSince(item.detail, item.link).length;
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

  if (!selected) return null;
  const link = selected.link;
  const chip = displayChip(link, summaryByKey, gitPr);
  const multiple = items.length > 1;
  const showDot = updateCount === null && items.some((item) => item.unseen);
  const title = [
    multiple ? linksTitle(links, summaryByKey, gitPr) : chip.title,
    updateCount ? `${updateCount} ${updateCount === 1 ? "update" : "updates"} since your last turn` : null,
    showDot ? "Updated since your last turn" : null,
    multiple ? "Choose a pull request" : "Open the pull request"
  ]
    .filter(Boolean)
    .join(" · ");

  const choose = (item: (typeof items)[number]) => {
    setMenuOpen(false);
    openPr(item.link.ref);
  };

  return (
    <span className="pr-panel-chip-wrap" ref={wrapRef}>
      <button
        className="pr-panel-chip"
        onClick={() => (multiple ? setMenuOpen((open) => !open) : openPr(link.ref))}
        title={title}
        aria-label={title}
        aria-haspopup={multiple ? "menu" : undefined}
        aria-expanded={multiple ? menuOpen : undefined}
      >
        <PrChipBadge chip={chip} extra={items.length - 1} title={title} />
        {updateCount !== null && updateCount > 0 && <span className="pr-panel-chip-count">{updateCount}</span>}
        {showDot && <span className="pr-panel-chip-dot" aria-hidden="true" />}
      </button>
      {multiple && menuOpen && (
        <div
          ref={menuRef}
          className="menu-panel menu-panel-down pr-links-menu"
          role="menu"
          aria-label="Linked pull requests"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMenuOpen(false);
          }}
        >
          {items.map((item) => {
            const pr = item.summary ?? item.detail;
            const label = pr ? `${prRefLabel(item.link.ref)} · ${pr.title}` : prRefLabel(item.link.ref);
            return (
              <div
                key={item.key}
                className="menu-row"
                role="menuitem"
                tabIndex={0}
                title={label}
                onClick={() => choose(item)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") choose(item);
                }}
              >
                <PrChipBadge chip={displayChip(item.link, summaryByKey, gitPr)} />
                <span className="name">{label}</span>
                {item.unseen && <span className="pr-panel-chip-dot" aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}

export function PrSessionPanel({ sessionId }: { sessionId: string }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { items, summaryByKey, gitPr, selected } = useSelectedLinkedPr(sessionId, selectedKey);
  const link = selected?.link;
  const summary = selected?.summary;
  const detail = selected?.detail;
  const loading = selected?.loading ?? false;
  const error = selected?.error;
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
      applySession(await window.cw.unlinkSessionPr(sessionId, link.ref));
      setSelectedKey(null);
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
                  setSelectedKey(item.key);
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
