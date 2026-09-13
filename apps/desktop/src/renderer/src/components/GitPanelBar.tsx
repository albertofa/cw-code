import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, GitBranch, GitFork } from "lucide-react";
import type { GitBranchInfo } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { MenuSelect } from "./MenuSelect.js";

function GitHubMark({ size = 11 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.3c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z" />
    </svg>
  );
}

export function GitPanelBar({ sessionId, compact = false }: { sessionId: string; compact?: boolean }) {
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  const refreshGitStatus = useAppStore((state) => state.refreshGitStatus);
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
    return () => { active = false; };
  }, [sessionId, refreshGitStatus]);

  const className = `gitbar${compact ? " gitbar-compact" : ""}`;

  if (!status) return <div className={className}><span className="gitbar-dim">Loading Git…</span></div>;
  if (!status.available) return <div className={className}><span className="gitbar-dim">Not a Git repository</span></div>;

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
    <div className={className}>
      <div className="gitbar-location">
        <MenuSelect
          label="Switch branch"
          direction="down"
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
        {status.isWorktree && (
          <span className="gitbar-checkout" title={`Worktree: ${status.worktreePath}`}>
            <GitFork size={12} />
            {status.worktreeName}
          </span>
        )}
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
      {error && <span className="gitbar-error" title={error}>Git error</span>}
      {(status.addedLines > 0 || status.deletedLines > 0) && (
        <span className="gitbar-lines" title={`${status.addedLines} added, ${status.deletedLines} deleted · ${status.dirtyCount} changed ${status.dirtyCount === 1 ? "file" : "files"}`}>
          {status.addedLines > 0 && <span className="add">+{status.addedLines}</span>}
          {status.deletedLines > 0 && <span className="del">-{status.deletedLines}</span>}
        </span>
      )}
    </div>
  );
}
