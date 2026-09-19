import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Folder, FolderOpen, GitBranch, GitFork } from "lucide-react";
import type { GitBranchInfo } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { useNotifs } from "./Notifications.js";
import { MenuSelect } from "./MenuSelect.js";
import { GitHubMark } from "./GitHubMark.js";
import { shortenHome } from "./pathDisplay.js";

export function GitPanelBar({ sessionId, compact = false }: { sessionId: string; compact?: boolean }) {
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  const [worktreeCard, setWorktreeCard] = useState<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const refreshGitStatus = useAppStore((state) => state.refreshGitStatus);
  const status = useAppStore((state) => state.gitStatusBySession[sessionId] ?? null);
  const homeDir = useAppStore((state) => state.homeDir);
  const shortPath = (value: string): string => shortenHome(value, homeDir ?? undefined);

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  useLayoutEffect(() => {
    if (!worktreeCard) return;
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(worktreeCard.x, window.innerWidth - r.width - 8));
    const y = Math.max(8, Math.min(worktreeCard.y, window.innerHeight - r.height - 8));
    if (x !== worktreeCard.x || y !== worktreeCard.y) setWorktreeCard({ x, y });
  }, [worktreeCard]);

  const showWorktreeCard = (el: HTMLElement) => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const r = el.getBoundingClientRect();
    const cardWidth = 300;
    const cardHeight = 160;
    setWorktreeCard({
      x: Math.max(8, Math.min(r.left, window.innerWidth - cardWidth - 8)),
      y: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - cardHeight - 8))
    });
  };

  const scheduleWorktreeClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setWorktreeCard(null), 120);
  };

  const cancelWorktreeClose = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  useEffect(() => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setWorktreeCard(null);
    let active = true;
    const updateBranches = () => {
      window.cw.listGitBranches(sessionId).then((items) => {
        if (active) { setBranches(items); setError(""); }
      }).catch((reason: Error) => { if (active) setError(reason.message); });
    };
    setError("");
    void refreshGitStatus(sessionId);
    updateBranches();
    return () => { active = false; };
  }, [sessionId, refreshGitStatus]);

  const className = `gitbar${compact ? " gitbar-compact" : ""}`;

  if (!status) return <div className={className}><span className="gitbar-dim">Loading Git…</span></div>;
  if (!status.available) return <div className={className}><span className="gitbar-dim">Not a Git repository</span></div>;

  const pullRequest = status.pullRequest;
  const checksClass = pullRequest ? pullRequest.checks.failed > 0 ? "failed" : pullRequest.checks.pending > 0 ? "pending" : "passed" : "";
  const openWorktree = () => {
    if (!status || !status.worktreePath) return;
    window.cw.openPath(status.worktreePath).catch((err: Error) =>
      useNotifs.getState().push({ kind: "error", title: "Could not open worktree", message: err.message })
    );
  };

  const switchBranch = (branch: string) => {
    setSwitching(true);
    setError("");
    window.cw.switchGitBranch(sessionId, branch).then(() => {
      void refreshGitStatus(sessionId);
      return window.cw.listGitBranches(sessionId);
    }).then(setBranches).catch((reason: Error) => setError(reason.message)).finally(() => setSwitching(false));
  };

  return (
    <>
      <div className={className}>
        <div className="gitbar-location">
          {status.isWorktree ? (
            <button
              type="button"
              className="gitbar-checkout"
              title={status.worktreePath ? `Worktree: ${status.worktreeName} — ${status.worktreePath} (click to open)` : "Worktree checkout"}
              onMouseEnter={(e) => showWorktreeCard(e.currentTarget)}
              onMouseLeave={scheduleWorktreeClose}
              onFocus={(e) => showWorktreeCard(e.currentTarget)}
              onBlur={scheduleWorktreeClose}
              onClick={openWorktree}
            >
              <GitFork size={12} aria-hidden="true" />
              Worktree
            </button>
          ) : (
            <span
              className="gitbar-checkout local"
              title={status.repositoryRoot ? `Local checkout: ${status.repositoryRoot}` : "Local checkout"}
            >
              <Folder size={12} aria-hidden="true" />
              Local checkout
            </span>
          )}
          <MenuSelect
            label="Switch branch"
            title={status.branch ? `Branch: ${status.branch} — switch branch` : "Switch branch"}
            direction="down"
            value={status.branch}
            display={switching ? "Switching…" : status.branch}
            icon={<GitBranch size={13} aria-hidden="true" />}
            options={branches.map((item) => ({
              id: item.name, label: item.label, hint: item.name,
              description: item.worktreePath && !item.current ? `Checked out at ${shortPath(item.worktreePath)}` : item.remote ? "Remote branch" : undefined,
              disabled: Boolean(item.worktreePath && !item.current), icon: <GitBranch size={13} />
            }))}
            onPick={switchBranch}
            searchable
            searchPlaceholder="Filter branches…"
          />
        </div>
        {pullRequest && (
          <button className="gitbar-item gitbar-pr" title={`${pullRequest.title} — open on GitHub`} onClick={() => void window.cw.openExternal(pullRequest.url)}>
            #{pullRequest.number} {pullRequest.isDraft ? "draft" : pullRequest.state.toLowerCase()} <ExternalLink size={11} />
          </button>
        )}
        {pullRequest && pullRequest.checks.total > 0 && (
          <span className={`gitbar-checks ${checksClass}`} title={`${pullRequest.checks.passed} passed, ${pullRequest.checks.failed} failed, ${pullRequest.checks.pending} pending`}>
            {pullRequest.checks.failed > 0 ? "checks failing" : pullRequest.checks.pending > 0 ? "checks running" : "checks passing"}
          </span>
        )}
        {status.githubAccount && (
          <span className="gitbar-account" title={`GitHub account selected by ${status.githubAccountSource}: ${status.githubAccount}@${status.githubHost}`}>
            <GitHubMark /> @{status.githubAccount}
          </span>
        )}
        {!pullRequest && status.githubError && <span className="gitbar-github-error" title={status.githubError}>GitHub unavailable</span>}
        {status.ahead > 0 && <span className="gitbar-ahead" title="Commits ahead of upstream"><ArrowUp size={11} />{status.ahead}</span>}
        {status.behind > 0 && <span className="gitbar-behind" title="Commits behind upstream"><ArrowDown size={11} />{status.behind}</span>}
        {(status.baseAhead ?? 0) > 0 && (
          <span
            className="gitbar-ahead gitbar-base-ahead"
            title={`${status.baseAhead} ${status.baseAhead === 1 ? "commit" : "commits"} ahead of ${status.baseRef ?? "base branch"}`}
          >
            <GitFork size={11} />{status.baseAhead}
          </span>
        )}
        {error && <span className="gitbar-error" title={error}>Git error</span>}
        {(status.addedLines > 0 || status.deletedLines > 0) && (
          <span className="gitbar-lines" title={`${status.addedLines} added, ${status.deletedLines} deleted · ${status.dirtyCount} changed ${status.dirtyCount === 1 ? "file" : "files"}`}>
            {status.addedLines > 0 && <span className="add">+{status.addedLines}</span>}
            {status.deletedLines > 0 && <span className="del">-{status.deletedLines}</span>}
          </span>
        )}
      </div>
      {worktreeCard && (
        <div
          ref={cardRef}
          className="session-hovercard interactive"
          style={{ left: worktreeCard.x, top: worktreeCard.y }}
          onMouseEnter={cancelWorktreeClose}
          onMouseLeave={scheduleWorktreeClose}
        >
          <div className="session-hovercard-row">
            <GitFork size={13} aria-hidden="true" />
            <span className="hovercard-text">{status.worktreeName}</span>
          </div>
          <div className="session-hovercard-row">
            <GitBranch size={13} aria-hidden="true" />
            <span className="hovercard-text" title={status.worktreePath}>{shortPath(status.worktreePath)}</span>
          </div>
          <button
            className="session-hovercard-action"
            onClick={() => {
              setWorktreeCard(null);
              openWorktree();
            }}
          >
            <FolderOpen size={13} aria-hidden="true" />
            Open worktree
          </button>
        </div>
      )}
    </>
  );
}
