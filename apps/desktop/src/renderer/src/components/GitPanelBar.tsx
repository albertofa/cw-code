import { useEffect, useState } from "react";
import { ExternalLink, GitBranch, GitFork, RefreshCw } from "lucide-react";
import type { GitBranchInfo, GitStatus } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { MenuSelect } from "./MenuSelect.js";

export function GitPanelBar({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  const refreshGitStatus = useAppStore((state) => state.refreshGitStatus);

  const refresh = () => {
    window.cw.getGitStatus(sessionId).then((next) => {
      setStatus(next);
      setError("");
      void refreshGitStatus(sessionId);
    }).catch((reason: Error) => setError(reason.message));
    window.cw.listGitBranches(sessionId).then(setBranches).catch(() => setBranches([]));
  };

  useEffect(() => {
    let active = true;
    const update = () => {
      window.cw.getGitStatus(sessionId).then((next) => {
        if (active) {
          setStatus(next);
          setError("");
        }
      }).catch((reason: Error) => {
        if (active) setError(reason.message);
      });
    };
    setStatus(null);
    setError("");
    update();
    window.cw.listGitBranches(sessionId).then((items) => {
      if (active) setBranches(items);
    }).catch(() => {});
    const timer = window.setInterval(update, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  if (!status) {
    return (
      <div className="gitbar">
        <span className="gitbar-dim">{error ? "Git unavailable" : "Loading Git…"}</span>
        <button className="icon-btn" title="Retry Git status" onClick={refresh}><RefreshCw size={13} /></button>
      </div>
    );
  }
  if (!status.available) return <div className="gitbar"><span className="gitbar-dim">Not a Git repository</span></div>;

  const pullRequest = status.pullRequest;
  const checksClass = pullRequest
    ? pullRequest.checks.failed > 0 ? "failed" : pullRequest.checks.pending > 0 ? "pending" : "passed"
    : "";
  const switchBranch = (branch: string) => {
    setSwitching(true);
    setError("");
    window.cw.switchGitBranch(sessionId, branch).then((next) => {
      setStatus(next);
      void refreshGitStatus(sessionId);
      return window.cw.listGitBranches(sessionId);
    }).then(setBranches).catch((reason: Error) => {
      setError(reason.message);
    }).finally(() => setSwitching(false));
  };

  return (
    <div className="gitbar">
      <span className="gitbar-worktree" title={status.worktreePath}><GitFork size={12} /> {status.worktreeName}</span>
      <MenuSelect
        label="Switch branch"
        value={status.branch}
        display={switching ? "Switching…" : status.branch}
        options={branches.map((item) => ({
          id: item.name,
          label: item.label,
          hint: item.name,
          description: item.worktreePath && !item.current
            ? `Checked out at ${item.worktreePath}`
            : item.remote ? "Remote branch" : undefined,
          disabled: Boolean(item.worktreePath && !item.current),
          icon: <GitBranch size={13} />
        }))}
        onPick={switchBranch}
        searchable
        searchPlaceholder="Filter branches…"
      />
      {pullRequest && (
        <button
          className="gitbar-item gitbar-pr"
          title={`${pullRequest.title} — open on GitHub`}
          onClick={() => void window.cw.openExternal(pullRequest.url)}
        >
          #{pullRequest.number} {pullRequest.isDraft ? "draft" : pullRequest.state.toLowerCase()} <ExternalLink size={11} />
        </button>
      )}
      {pullRequest && pullRequest.checks.total > 0 && (
        <span
          className={`gitbar-checks ${checksClass}`}
          title={`${pullRequest.checks.passed} passed, ${pullRequest.checks.failed} failed, ${pullRequest.checks.pending} pending`}
        >
          {pullRequest.checks.failed > 0 ? "checks failing" : pullRequest.checks.pending > 0 ? "checks running" : "checks passing"}
        </span>
      )}
      {!pullRequest && status.githubError && <span className="gitbar-github-error" title={status.githubError}>GitHub unavailable</span>}
      {!status.clean && <span className="gitbar-item gitbar-dirty" title="Uncommitted changes">{status.dirtyCount} changed</span>}
      {status.ahead > 0 && <span className="gitbar-ahead" title="Commits ahead of upstream">↑{status.ahead}</span>}
      {status.behind > 0 && <span className="gitbar-behind" title="Commits behind upstream">↓{status.behind}</span>}
      {error && <span className="gitbar-error" title={error}>Branch switch failed</span>}
      <button className="icon-btn" title="Refresh Git and GitHub status" aria-label="Refresh Git status" onClick={refresh}>
        <RefreshCw size={13} />
      </button>
    </div>
  );
}
