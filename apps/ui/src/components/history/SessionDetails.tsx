import { GitFork, GitPullRequest, MessagesSquare } from "lucide-react";
import type { HistoryWorktree, PrRef, SessionRow } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { sessionDotStatus, sessionStatusText } from "./sidebarModel.js";

export function SessionDetails({
  row,
  isThis,
  worktree,
  viewing,
  onOpenSession,
  onShowHistory,
  onSelectPr
}: {
  row: SessionRow | undefined;
  isThis: boolean;
  worktree: HistoryWorktree | null;
  viewing: boolean;
  onOpenSession: (sessionId: string) => void;
  onShowHistory: (path: string) => void;
  onSelectPr: (ref: PrRef) => void;
}) {
  if (!row) return <div className="gg-note gg-details-empty">This session is no longer listed. It may have been resolved or archived.</div>;
  const { session } = row;
  const links = session.prs ?? [];
  const firstPr = links[0]?.ref ?? null;
  const branch = row.branch ?? session.branch ?? null;
  const checkout = worktree?.path ?? session.worktreePath ?? null;
  const historyBlocked = !worktree ? "Its checkout is not a worktree of this repository" : viewing ? "You are viewing its history" : null;

  return (
    <div className="gg-card">
      <div className="gg-card-top">
        <span className={`gg-sb-dot status-${sessionDotStatus(row)}`} aria-hidden="true" />
        <span className="gg-card-title">{session.title}</span>
        {isThis && <span className="gg-tag me">this session</span>}
      </div>
      <div className="gg-kv gg-card-kv">
        <span>Status</span>
        <span className="gg-kv-text">{sessionStatusText(row)}</span>
        <span>Branch</span>
        <span className="gg-sha">{branch ?? "unknown"}</span>
        <span>{worktree?.isMain ? "Checkout" : "Worktree"}</span>
        <span className="gg-sha">{checkout ?? "Main checkout (folder session)"}</span>
        <span>PR</span>
        <span className="gg-kv-value">
          {links.length === 0 ? (
            <span className="gg-note">None yet</span>
          ) : (
            links.map((link) => (
              <button key={prKey(link.ref)} type="button" className="gg-chip" onClick={() => onSelectPr(link.ref)} title={`Show #${link.ref.number}`}>
                #{link.ref.number}
              </button>
            ))
          )}
        </span>
      </div>
      <div className="gg-actions gg-actions-spaced">
        {!isThis && (
          <button type="button" className="gg-action primary" onClick={() => onOpenSession(session.id)}>
            <MessagesSquare size={12} aria-hidden="true" />
            Open session
          </button>
        )}
        <button
          type="button"
          className="gg-action"
          aria-disabled={historyBlocked ? "true" : undefined}
          title={historyBlocked ?? `Show the history of ${worktree?.name ?? "its worktree"}`}
          onClick={() => {
            if (worktree && !historyBlocked) onShowHistory(worktree.path);
          }}
        >
          <GitFork size={12} aria-hidden="true" />
          Show its history
        </button>
        {firstPr && (
          <button type="button" className="gg-action" onClick={() => onSelectPr(firstPr)}>
            <GitPullRequest size={12} aria-hidden="true" />
            PR #{firstPr.number}
          </button>
        )}
      </div>
    </div>
  );
}
