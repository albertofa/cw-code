import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import type { HistoryCommitDetail } from "@cw-code/contracts";
import { parseUnifiedDiff, type DiffFile } from "../diffParser.js";
import { DiffLines, STATUS_BADGE } from "../GitInspectPanel.js";
import { FileIcon } from "../fileIcons.js";
import { splitRepoPath } from "../turnChanges.js";

const LOAD_DELAY_MS = 120;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatDate(seconds: number): string {
  return dateFormat.format(new Date(seconds * 1000));
}

export interface HistoryCommitState {
  detail: HistoryCommitDetail | null;
  files: DiffFile[];
  error: string;
}

export function useHistoryCommit(sessionId: string, sha: string | null): HistoryCommitState {
  const [detail, setDetail] = useState<HistoryCommitDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setDetail(null);
    setError("");
    if (!sha) return;
    let active = true;
    const timer = setTimeout(() => {
      window.cw.getHistoryCommit(sessionId, sha).then(
        (next) => {
          if (active) setDetail(next);
        },
        (reason: Error) => {
          if (active) setError(reason.message);
        }
      );
    }, LOAD_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [sessionId, sha]);

  const files = useMemo(() => parseUnifiedDiff(detail?.patch ?? ""), [detail]);
  return { detail, files, error };
}

function FileStats({ file }: { file: DiffFile }) {
  return (
    <>
      <span className={`diff-badge ${file.status}`}>{STATUS_BADGE[file.status]}</span>
      {file.binary ? (
        <span className="inspect-binary">binary</span>
      ) : (
        <span className="inspect-dfh-stats">
          <span className="add">+{file.added}</span>
          <span className="del">−{file.removed}</span>
        </span>
      )}
    </>
  );
}

export function HistoryCommitSidebar({
  commit,
  openPath,
  onOpenFile,
  onSelect
}: {
  commit: HistoryCommitState;
  openPath: string | null;
  onOpenFile: (path: string) => void;
  onSelect: (sha: string) => void;
}) {
  const { detail, files, error } = commit;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");

  useEffect(() => {
    setCopied(false);
    setCopyError("");
  }, [detail?.sha]);

  if (error) return <div className="inspect-error">Commit unavailable: {error}</div>;
  if (!detail) return <div className="diff-empty">Loading commit…</div>;

  const copySha = (): void => {
    void navigator.clipboard.writeText(detail.sha).then(
      () => setCopied(true),
      () => setCopyError("Could not copy the commit id")
    );
  };

  const sameCommitter = detail.committerEmail === detail.authorEmail && detail.committerName === detail.authorName;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);

  return (
    <>
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
          {copyError && <span className="inspect-error">{copyError}</span>}
        </div>
      </div>
      <div className="inspect-summary">
        <span>
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
        <span className="add">+{added}</span>
        <span className="del">−{removed}</span>
        {detail.parents.length > 1 && <span className="inspect-range">vs first parent</span>}
      </div>
      {detail.patchTruncated && <div className="inspect-note">This commit is too large to show in full; later files are cut off.</div>}
      {files.length === 0 && <div className="inspect-dfile-note">No file changes</div>}
      <div className="history-files" role="list" aria-label="Changed files">
        {files.map((file) => {
          const { dir, name } = splitRepoPath(file.path);
          return (
            <button
              key={file.path}
              type="button"
              role="listitem"
              className={`history-file${file.path === openPath ? " active" : ""}`}
              onClick={() => onOpenFile(file.path)}
              title={file.path}
            >
              <FileIcon name={name} size={13} />
              <span className="history-file-path">
                <span className="history-file-name">{name}</span>
                {dir && <span className="history-file-dir">{dir}</span>}
              </span>
              <span className="history-file-end">
                <FileStats file={file} />
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function HistoryFileDiff({
  files,
  path,
  onOpenFile,
  onClose
}: {
  files: DiffFile[];
  path: string;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const index = files.findIndex((file) => file.path === path);
  const file = index === -1 ? null : files[index];
  const prev = index > 0 ? files[index - 1] : null;
  const next = index !== -1 && index < files.length - 1 ? files[index + 1] : null;

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.querySelector(".diff-body")?.scrollTo({ top: 0 });
  }, [path]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    } else if (event.altKey && event.key === "ArrowUp" && prev) {
      event.preventDefault();
      onOpenFile(prev.path);
    } else if (event.altKey && event.key === "ArrowDown" && next) {
      event.preventDefault();
      onOpenFile(next.path);
    }
  };

  const { dir, name } = splitRepoPath(path);

  return (
    <div ref={ref} className="history-detail" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="history-detail-bar">
        <button type="button" className="inspect-mode" onClick={onClose} title="Back to the graph (Esc)" aria-label="Back to the graph">
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <span className="history-file-title" title={path}>
          <FileIcon name={name} size={13} />
          {dir && <span className="inspect-dfh-dir">{dir}</span>}
          <span className="inspect-dfh-name">{name}</span>
        </span>
        {file && <FileStats file={file} />}
        <span className="history-detail-actions">
          <button type="button" className="inspect-mode" disabled={!prev} onClick={() => prev && onOpenFile(prev.path)} title="Previous file (Alt+↑)" aria-label="Previous file">
            <ChevronUp size={14} aria-hidden="true" />
          </button>
          <button type="button" className="inspect-mode" disabled={!next} onClick={() => next && onOpenFile(next.path)} title="Next file (Alt+↓)" aria-label="Next file">
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </span>
      </div>
      {!file && <div className="inspect-dfile-note">This file is not part of the commit</div>}
      {file && <DiffLines file={file} />}
    </div>
  );
}
