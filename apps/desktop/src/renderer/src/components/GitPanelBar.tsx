import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpFromLine,
  ChevronDown,
  CircleCheck,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  Loader,
  X
} from "lucide-react";
import type { GitBranchInfo } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { useNotifs } from "./Notifications.js";
import { MenuSelect } from "./MenuSelect.js";
import { GitHubMark } from "./GitHubMark.js";
import { shortenHome } from "./pathDisplay.js";

export function GitPanelBar({ sessionId }: { sessionId: string }) {
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  const [hoverCard, setHoverCard] = useState<
    | { kind: "worktree"; x: number; y: number }
    | { kind: "stats"; x: number; y: number }
    | null
  >(null);
  const [ghOpen, setGhOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const refreshGitStatus = useAppStore((state) => state.refreshGitStatus);
  const status = useAppStore((state) => state.gitStatusBySession[sessionId] ?? null);
  const homeDir = useAppStore((state) => state.homeDir);
  const shortPath = (value: string): string => shortenHome(value, homeDir ?? undefined);

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!ghOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGhOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ghOpen]);

  useLayoutEffect(() => {
    if (!hoverCard) return;
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(hoverCard.x, window.innerWidth - r.width - 8));
    const y = Math.max(8, Math.min(hoverCard.y, window.innerHeight - r.height - 8));
    if (x !== hoverCard.x || y !== hoverCard.y) setHoverCard({ ...hoverCard, x, y });
  }, [hoverCard]);

  const showHoverCard = (kind: "worktree" | "stats", el: HTMLElement) => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const r = el.getBoundingClientRect();
    const cardWidth = 300;
    const cardHeight = 160;
    setHoverCard({
      kind,
      x: Math.max(8, Math.min(r.left, window.innerWidth - cardWidth - 8)),
      y: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - cardHeight - 8))
    });
  };

  const scheduleHoverClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHoverCard(null), 120);
  };

  const cancelHoverClose = () => {
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
    setHoverCard(null);
    setGhOpen(false);
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

  if (!status) return <div className="gitbar gitbar-head"><span className="gitbar-dim">Loading Git…</span></div>;
  if (!status.available) return <div className="gitbar gitbar-head"><span className="gitbar-dim">Not a Git repository</span></div>;

  const pullRequest = status.pullRequest;
  const pillState = pullRequest
    ? pullRequest.checks.failed > 0
      ? "fail"
      : pullRequest.checks.pending > 0
        ? "pending"
        : "ok"
    : "ok";
  const prStateLabel = pullRequest
    ? pullRequest.isDraft
      ? "draft"
      : pullRequest.state.toLowerCase()
    : "";
  const checksLabel = pullRequest
    ? pullRequest.checks.total === 0
      ? ""
      : pullRequest.checks.failed > 0
        ? "checks failing"
        : pullRequest.checks.pending > 0
          ? "checks running"
          : "checks passing"
    : "";
  const pillTitle = pullRequest
    ? checksLabel
      ? `PR #${pullRequest.number} ${prStateLabel} · ${checksLabel}`
      : `PR #${pullRequest.number} ${prStateLabel}`
    : "";

  const openWorktree = () => {
    if (!status || !status.worktreePath) return;
    window.cw.openPath(status.worktreePath).catch((err: Error) =>
      useNotifs.getState().push({ kind: "error", title: "Could not open worktree", message: err.message })
    );
  };

  const openRoot = () => {
    if (!status.repositoryRoot) return;
    window.cw.openPath(status.repositoryRoot).catch((err: Error) =>
      useNotifs.getState().push({ kind: "error", title: "Could not open repository", message: err.message })
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

  const notAvailable = (action: string) => {
    setGhOpen(false);
    useNotifs.getState().push({
      kind: "info",
      title: "Not available yet",
      message: `${action} is not available yet…`
    });
  };

  const openPr = () => {
    setGhOpen(false);
    if (!pullRequest) return;
    void window.cw.openExternal(pullRequest.url);
  };

  const showStats =
    status.ahead > 0 ||
    status.behind > 0 ||
    status.addedLines > 0 ||
    status.deletedLines > 0 ||
    status.dirtyCount > 0;
  const hasSync = status.ahead > 0 || status.behind > 0;
  const hasLines = status.addedLines > 0 || status.deletedLines > 0;
  const statsTitle = [
    status.ahead > 0 ? `↑${status.ahead} ahead` : null,
    status.behind > 0 ? `↓${status.behind} behind` : null,
    status.addedLines > 0 ? `+${status.addedLines} added` : null,
    status.deletedLines > 0 ? `−${status.deletedLines} deleted` : null,
    status.dirtyCount > 0 ? `${status.dirtyCount} ${status.dirtyCount === 1 ? "file" : "files"}` : null
  ].filter(Boolean).join(" · ");

  return (
    <>
      <div
        className="gitbar gitbar-head"
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="gitbar-location">
          {status.isWorktree ? (
            <button
              type="button"
              className="gitbar-checkout"
              title={status.worktreePath ? `Worktree: ${status.worktreeName} — ${status.worktreePath} (click to open)` : "Worktree checkout"}
              onMouseEnter={(e) => showHoverCard("worktree", e.currentTarget)}
              onMouseLeave={scheduleHoverClose}
              onFocus={(e) => showHoverCard("worktree", e.currentTarget)}
              onBlur={scheduleHoverClose}
              onClick={openWorktree}
            >
              <GitFork size={12} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="gitbar-checkout"
              title={status.repositoryRoot ? `Local checkout: ${status.repositoryRoot} (click to open)` : "Local checkout"}
              onClick={openRoot}
            >
              <Folder size={12} aria-hidden="true" />
            </button>
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
          <button
            type="button"
            className={`git-status-pill ${pillState}`}
            title={pillTitle}
            onClick={() => void window.cw.openExternal(pullRequest.url)}
          >
            <span>#{pullRequest.number}</span>
            <span className="pill-icon" aria-hidden="true">
              {pillState === "fail" ? (
                <X size={11} />
              ) : pillState === "pending" ? (
                <Loader size={11} />
              ) : (
                <CircleCheck size={11} />
              )}
            </span>
          </button>
        )}
        {showStats && (
          <button
            type="button"
            className="git-stats"
            title={statsTitle}
            onMouseEnter={(e) => showHoverCard("stats", e.currentTarget)}
            onMouseLeave={scheduleHoverClose}
            onFocus={(e) => showHoverCard("stats", e.currentTarget)}
            onBlur={scheduleHoverClose}
          >
            {status.ahead > 0 && (
              <span className="ahead">
                <ArrowUp size={11} aria-hidden="true" />
                {status.ahead}
              </span>
            )}
            {status.behind > 0 && (
              <span className="behind">
                <ArrowDown size={11} aria-hidden="true" />
                {status.behind}
              </span>
            )}
            {hasSync && hasLines && <span className="sep" aria-hidden="true">·</span>}
            {status.addedLines > 0 && <span className="add">+{status.addedLines}</span>}
            {status.deletedLines > 0 && <span className="del">-{status.deletedLines}</span>}
            {!hasSync && !hasLines && status.dirtyCount > 0 && (
              <span className="dirty">{status.dirtyCount}</span>
            )}
          </button>
        )}
        {!pullRequest && status.githubError && (
          <span className="gitbar-github-error" title={status.githubError}>GitHub unavailable</span>
        )}
        {error && <span className="gitbar-error" title={error}>Git error</span>}
        <div className="gh-wrap">
          <button
            type="button"
            className="gh-btn"
            aria-haspopup="menu"
            aria-expanded={ghOpen}
            aria-label="GitHub actions"
            title="GitHub actions"
            onClick={() => setGhOpen((o) => !o)}
          >
            <GitHubMark size={12} />
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {ghOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setGhOpen(false)} />
              <div className="gh-menu" role="menu" aria-label="GitHub">
                <div className="gh-menu-head">
                  <span className="gh-avatar" aria-hidden="true">
                    {status.githubAccount ? status.githubAccount.charAt(0).toUpperCase() : "?"}
                  </span>
                  <span
                    className="gh-account"
                    title={status.githubAccount ? `GitHub account selected by ${status.githubAccountSource}: ${status.githubAccount}@${status.githubHost}` : undefined}
                  >
                    {status.githubAccount ? `@${status.githubAccount}` : "No GitHub account"}
                  </span>
                  <span className="gh-label">GitHub</span>
                </div>
                <button type="button" className="gh-menu-item" role="menuitem" onClick={() => notAvailable("Commit")}>
                  <GitCommitHorizontal size={13} aria-hidden="true" />
                  Commit
                </button>
                <button type="button" className="gh-menu-item" role="menuitem" onClick={() => notAvailable("Commit & push")}>
                  <ArrowUpFromLine size={13} aria-hidden="true" />
                  Commit &amp; push
                </button>
                <button type="button" className="gh-menu-item" role="menuitem" onClick={() => notAvailable("Push")}>
                  <ArrowUp size={13} aria-hidden="true" />
                  Push
                </button>
                <button type="button" className="gh-menu-item" role="menuitem" onClick={() => notAvailable("Pull")}>
                  <ArrowDown size={13} aria-hidden="true" />
                  Pull
                </button>
                <div className="gh-menu-sep" aria-hidden="true" />
                <button
                  type="button"
                  className={`gh-menu-item${pullRequest ? "" : " disabled"}`}
                  role="menuitem"
                  aria-disabled={pullRequest ? undefined : "true"}
                  title={pullRequest ? pullRequest.title : "No pull request"}
                  onClick={openPr}
                >
                  <GitPullRequest size={13} aria-hidden="true" />
                  Create pull request
                </button>
                <button
                  type="button"
                  className={`gh-menu-item${pullRequest ? "" : " disabled"}`}
                  role="menuitem"
                  aria-disabled={pullRequest ? undefined : "true"}
                  title={pullRequest ? "Open pull request on GitHub" : "No pull request"}
                  onClick={openPr}
                >
                  <GitHubMark size={13} />
                  View on GitHub
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {hoverCard?.kind === "worktree" && (
        <div
          ref={cardRef}
          className="session-hovercard interactive"
          style={{ left: hoverCard.x, top: hoverCard.y }}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
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
              setHoverCard(null);
              openWorktree();
            }}
          >
            <FolderOpen size={13} aria-hidden="true" />
            Open worktree
          </button>
        </div>
      )}
      {hoverCard?.kind === "stats" && (
        <div
          ref={cardRef}
          className="session-hovercard interactive"
          style={{ left: hoverCard.x, top: hoverCard.y }}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
        >
          <div className="session-hovercard-title">Working tree</div>
          <div className="session-hovercard-row">
            <GitBranch size={13} aria-hidden="true" />
            <span className="hovercard-text">{status.branch}</span>
          </div>
          {status.ahead > 0 || status.behind > 0 ? (
            <div className="session-hovercard-row">
              <ArrowUp size={13} aria-hidden="true" />
              <span className="hovercard-text">
                {status.ahead > 0 && status.behind > 0
                  ? `${status.ahead} ahead · ${status.behind} behind`
                  : status.ahead > 0
                    ? `${status.ahead} ahead of upstream`
                    : `${status.behind} behind upstream`}
              </span>
            </div>
          ) : null}
          {status.addedLines > 0 || status.deletedLines > 0 ? (
            <div className="session-hovercard-row">
              <GitCommitHorizontal size={13} aria-hidden="true" />
              <span className="hovercard-text">
                {[
                  status.addedLines > 0 ? `+${status.addedLines} added` : null,
                  status.deletedLines > 0 ? `−${status.deletedLines} deleted` : null
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
          ) : null}
          <div className="session-hovercard-row">
            <Folder size={13} aria-hidden="true" />
            <span className="hovercard-text">
              {status.dirtyCount > 0
                ? `${status.dirtyCount} uncommitted ${status.dirtyCount === 1 ? "change" : "changes"}`
                : "Clean working tree"}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
