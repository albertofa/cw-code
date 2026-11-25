import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { HistoryCommitDetail } from "@cw-code/contracts";
import { DiffFileSection } from "../GitInspectPanel.js";
import { parseUnifiedDiff } from "../diffParser.js";

const EXPAND_ALL_LIMIT = 8;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatDate(seconds: number): string {
  return dateFormat.format(new Date(seconds * 1000));
}

export function HistoryCommitView({ sessionId, sha, onSelect }: { sessionId: string; sha: string; onSelect: (sha: string) => void }) {
  const [detail, setDetail] = useState<HistoryCommitDetail | null>(null);
  const [error, setError] = useState("");
  const [openByPath, setOpenByPath] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setError("");
    setOpenByPath({});
    setCopied(false);
    window.cw.getHistoryCommit(sessionId, sha).then(
      (next) => {
        if (active) setDetail(next);
      },
      (reason: Error) => {
        if (active) setError(reason.message);
      }
    );
    return () => {
      active = false;
    };
  }, [sessionId, sha]);

  const files = useMemo(() => parseUnifiedDiff(detail?.patch ?? ""), [detail]);
  const defaultOpen = files.length <= EXPAND_ALL_LIMIT;
  const toggleFile = useCallback((path: string) => {
    setOpenByPath((prev) => ({ ...prev, [path]: !(prev[path] ?? defaultOpen) }));
  }, [defaultOpen]);

  const copySha = (): void => {
    void navigator.clipboard.writeText(sha).then(
      () => setCopied(true),
      () => setError("Could not copy the commit id")
    );
  };

  if (error) return <div className="inspect-error">Commit unavailable: {error}</div>;
  if (!detail) return <div className="diff-empty">Loading commit…</div>;

  const sameCommitter = detail.committerEmail === detail.authorEmail && detail.committerName === detail.authorName;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);

  return (
    <div className="history-detail">
      <div className="history-detail-head">
        <div className="history-detail-subject">{detail.subject}</div>
        {detail.body && <pre className="history-detail-body">{detail.body}</pre>}
        <div className="history-detail-meta">
          <span>
            {detail.authorName} &lt;{detail.authorEmail}&gt; · {formatDate(detail.authorDate)}
          </span>
          {!sameCommitter && (
            <span>
              Committed by {detail.committerName} &lt;{detail.committerEmail}&gt; · {formatDate(detail.committerDate)}
            </span>
          )}
          <span className="history-detail-ids">
            <button type="button" className="history-sha" onClick={copySha} title="Copy commit id">
              {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
              {detail.sha.slice(0, 10)}
            </button>
            {detail.parents.length > 0 && <span className="history-parents-label">{detail.parents.length > 1 ? "parents" : "parent"}</span>}
            {detail.parents.map((parent) => (
              <button key={parent} type="button" className="history-parent" onClick={() => onSelect(parent)} title={parent}>
                {parent.slice(0, 7)}
              </button>
            ))}
          </span>
        </div>
      </div>
      <div className="inspect-summary">
        <span>
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
        <span className="add">+{added}</span>
        <span className="del">−{removed}</span>
        {detail.parents.length > 1 && <span className="inspect-range">compared with the first parent</span>}
      </div>
      {detail.patchTruncated && <div className="inspect-note">This commit is too large to show in full; later files are cut off.</div>}
      {files.length === 0 && <div className="inspect-dfile-note">No file changes</div>}
      <div className="inspect-stack">
        {files.map((file) => (
          <DiffFileSection key={file.path} file={file} open={openByPath[file.path] ?? defaultOpen} onToggle={toggleFile} />
        ))}
      </div>
    </div>
  );
}
