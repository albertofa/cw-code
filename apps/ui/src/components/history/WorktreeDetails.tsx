import { ArrowDown, ArrowUp, Folder, GitFork, GitPullRequest, MessagesSquare } from "lucide-react";
import type { HistoryRef, HistoryScope } from "@cw-code/contracts";
import { COMMIT_PULLS_NO_GITHUB_REMOTE } from "@cw-code/shared/commitPulls";
import { prKey } from "@cw-code/shared/prRef";
import { CommitPrCard, Note, RetryError, useCommitPulls } from "./CommitPulls.js";
import { branchPulls } from "./branchPulls.js";
import type { SidebarWorktree } from "./sidebarModel.js";

function BranchPulls({
  scope,
  head,
  branch,
  upstream,
  linkedKeys
}: {
  scope: HistoryScope;
  head: string;
  branch: string;
  upstream: string | null;
  linkedKeys: ReadonlySet<string>;
}) {
  const { result, error, retry } = useCommitPulls(scope, head);
  if (error) return <RetryError onRetry={retry}>Could not look up pull requests: {error}</RetryError>;
  if (!result) return <Note>Looking up the pull request for {branch}…</Note>;
  if (result.unavailable === COMMIT_PULLS_NO_GITHUB_REMOTE) return <Note>{result.unavailable}</Note>;
  if (result.unavailable) return <RetryError onRetry={retry}>{result.unavailable}</RetryError>;
  const pulls = branchPulls(result.pulls, branch, upstream);
  if (pulls.length === 0) return <Note>No pull request for {branch}.</Note>;
  return (
    <>
      {pulls.map((pull) => (
        <CommitPrCard key={prKey(pull.ref)} pull={pull} linked={linkedKeys.has(prKey(pull.ref))} />
      ))}
    </>
  );
}

export function WorktreeDetails({
  scope,
  entry,
  sessionId,
  branchRef,
  viewing,
  linkedKeys,
  onShowHistory,
  onOpenSession
}: {
  scope: HistoryScope;
  entry: SidebarWorktree | undefined;
  sessionId: string | null;
  branchRef: HistoryRef | undefined;
  viewing: boolean;
  linkedKeys: ReadonlySet<string>;
  onShowHistory: (path: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  if (!entry) return <div className="gg-note gg-details-empty">This worktree is no longer listed. It may have been removed.</div>;
  const { worktree, owner, isHome } = entry;
  const ownerId = owner?.session.id ?? null;
  const Icon = worktree.isMain ? Folder : GitFork;

  return (
    <div className="gg-worktree-details">
      <div className="gg-card">
        <div className="gg-card-top">
          <Icon size={14} aria-hidden="true" />
          <span className="gg-card-title">
            {worktree.name}
            {worktree.isMain ? " · main checkout" : ""}
          </span>
          {isHome && sessionId && <span className="gg-tag me">this session</span>}
        </div>
        <div className="gg-kv gg-card-kv">
          <span>Branch</span>
          <span className="gg-kv-value">
            <span className="gg-sha">{worktree.branch ?? `detached at ${worktree.head?.slice(0, 7) ?? "unknown"}`}</span>
            {branchRef?.upstream && !branchRef.upstreamGone && (branchRef.ahead > 0 || branchRef.behind > 0) && (
              <span className="gg-ab" title={`Compared with ${branchRef.upstream}`}>
                {branchRef.ahead > 0 && (
                  <span>
                    <ArrowUp size={11} aria-hidden="true" />
                    {branchRef.ahead}
                  </span>
                )}
                {branchRef.behind > 0 && (
                  <span>
                    <ArrowDown size={11} aria-hidden="true" />
                    {branchRef.behind}
                  </span>
                )}
              </span>
            )}
          </span>
          <span>Path</span>
          <span className="gg-sha">{worktree.path}</span>
          <span>Used by</span>
          <span className="gg-kv-text">{owner ? owner.session.title : "No cw-code session"}</span>
        </div>
        <div className="gg-actions gg-actions-spaced">
          <button
            type="button"
            className="gg-action primary"
            aria-disabled={viewing ? "true" : undefined}
            title={viewing ? "You are viewing its history" : `Show the history of ${worktree.name}`}
            onClick={() => {
              if (!viewing) onShowHistory(worktree.path);
            }}
          >
            <GitFork size={12} aria-hidden="true" />
            Show its history
          </button>
          {ownerId && ownerId !== sessionId && (
            <button type="button" className="gg-action" onClick={() => onOpenSession(ownerId)}>
              <MessagesSquare size={12} aria-hidden="true" />
              Open that session
            </button>
          )}
        </div>
      </div>
      <section className="gg-d-sec" aria-label="Pull request">
        <h4 className="gg-d-h">
          <GitPullRequest size={12} aria-hidden="true" />
          Pull request
        </h4>
        {!worktree.branch ? (
          <Note>This worktree has no branch checked out, so it has no pull request.</Note>
        ) : !worktree.head ? (
          <Note>{worktree.branch} has no commits yet.</Note>
        ) : (
          <BranchPulls scope={scope} head={worktree.head} branch={worktree.branch} upstream={branchRef?.upstream ?? null} linkedKeys={linkedKeys} />
        )}
      </section>
    </div>
  );
}
