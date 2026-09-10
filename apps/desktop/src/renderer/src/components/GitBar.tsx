import { useEffect, useState } from "react";
import type { GitStatus } from "../cw.js";

export function GitBar({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = () => {
      window.cw
        .getGitStatus(sessionId)
        .then((s) => {
          if (cancelled) return;
          setStatus(s);
          setError(false);
        })
        .catch(() => {
          if (cancelled) return;
          setError(true);
        });
    };
    setStatus(null);
    setError(false);
    fetchStatus();
    const timer = window.setInterval(fetchStatus, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  if (error && !status) {
    return (
      <div className="gitbar">
        <span className="gitbar-dim">git unavailable</span>
        <button className="icon-btn" title="Retry git status" onClick={() => window.cw.getGitStatus(sessionId).then(setStatus).catch(() => setError(true))}>
          ⟳
        </button>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="gitbar">
        <span className="gitbar-dim">loading git…</span>
      </div>
    );
  }

  return (
    <div className="gitbar">
      <span className="gitbar-item" title="Branch">
        {status.branch} ▾
      </span>
      {status.prNumber != null && (
        <span className="gitbar-item gitbar-pr" title="Pull request">
          ⋔ #{status.prNumber}
        </span>
      )}
      {!status.clean && (
        <span className="gitbar-item gitbar-dirty" title="Uncommitted changes">
          {status.dirtyCount} changed
        </span>
      )}
      <button
        className="icon-btn"
        title="Refresh git status"
        aria-label="Refresh git status"
        onClick={() => window.cw.getGitStatus(sessionId).then(setStatus).catch(() => setError(true))}
      >
        ⟳
      </button>
    </div>
  );
}
