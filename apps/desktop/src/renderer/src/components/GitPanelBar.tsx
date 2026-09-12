import { useEffect, useState } from "react";
import { ExternalLink, FolderGit2, GitBranch, GitFork } from "lucide-react";
import type { GitBranchInfo } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { MenuSelect } from "./MenuSelect.js";

export function GitPanelBar({ sessionId }: { sessionId: string }) {
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  const refreshGitStatus = useAppStore((state) => state.refreshGitStatus);
  const refreshInterval = useAppStore((state) => state.sourceControlRefreshIntervalSeconds);
  const status = useAppStore((state) => state.gitStatusBySession[sessionId] ?? null);

  useEffect(() => {
    let active = true;
    const updateBranches = () => {
      window.cw.listGitBranches(sessionId).then((items) => {
        if (active) { setBranches(items); setError(""); }
      }).catch((reason: Error) => { if (active) setError(reason.message); });
    };
    setError("");
    void refreshGitStatus(sessionId);
    updateBranches();
    const timer = window.setInterval(updateBranches, refreshInterval * 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [sessionId, refreshInterval, refreshGitStatus]);

  if (!status) return <div className="gitbar"><span className="gitbar-dim">Loading Git…</span></div>;
  if (!status.available) return <div className="gitbar"><span className="gitbar-dim">Not a Git repository</span></div>;

  const pullRequest = status.pullRequest;
  const checksClass = pullRequest ? pullRequest.checks.failed > 0 ? "failed" : pullRequest.checks.pending > 0 ? "pending" : "passed" : "";
  const switchBranch = (branch: string) => {
    setSwitching(true);
    setError("");
    window.cw.switchGitBranch(sessionId, branch).then(() => {
      void refreshGitStatus(sessionId);
      return window.cw.listGitBranches(sessionId);
    }).then(setBranches).catch((reason: Error) => setError(reason.message)).finally(() => setSwitching(false));
  };

  return (
    <div className="gitbar">
      <MenuSelect
        label="Switch branch"
        value={status.branch}
        display={switching ? "Switching…" : status.branch}
        options={branches.map((item) => ({
          id: item.name, label: item.label, hint: item.name,
          description: item.worktreePath && !item.current ? `Checked out at ${item.worktreePath}` : item.remote ? "Remote branch" : undefined,
          disabled: Boolean(item.worktreePath && !item.current), icon: <GitBranch size={13} />
        }))}
        onPick={switchBranch}
        searchable
        searchPlaceholder="Filter branches…"
      />
      <span
        className="gitbar-checkout"
        title={status.isWorktree ? `Worktree: ${status.worktreePath}` : `Local checkout: ${status.worktreePath}`}
      >
        {status.isWorktree ? <GitFork size={12} /> : <FolderGit2 size={12} />}
        {status.isWorktree ? status.worktreeName : "Local checkout"}
      </span>
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
      {status.githubAccount && <span className="gitbar-account" title={`GitHub account selected by ${status.githubAccountSource}: ${status.githubAccount}@${status.githubHost}`}>@{status.githubAccount}</span>}
      {!pullRequest && status.githubError && <span className="gitbar-github-error" title={status.githubError}>GitHub unavailable</span>}
      {!status.clean && (
        <span className="gitbar-lines" title={`${status.dirtyCount} changed ${status.dirtyCount === 1 ? "file" : "files"}`}>
          <span className="add">+{status.addedLines}</span>
          <span className="del">-{status.deletedLines}</span>
        </span>
      )}
      {status.ahead > 0 && <span className="gitbar-ahead" title="Commits ahead of upstream">↑{status.ahead}</span>}
      {status.behind > 0 && <span className="gitbar-behind" title="Commits behind upstream">↓{status.behind}</span>}
      {error && <span className="gitbar-error" title={error}>Branch list unavailable</span>}
    </div>
  );
}
