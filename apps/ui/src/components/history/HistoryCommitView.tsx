import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ChevronDown, ChevronUp } from "lucide-react";
import type { HistoryCommitDetail, HistoryScope } from "@cw-code/contracts";
import { parseUnifiedDiff, type DiffFile } from "../diffParser.js";
import { DiffLines, STATUS_BADGE } from "../GitInspectPanel.js";
import { FileIcon } from "../fileIcons.js";
import { splitRepoPath } from "../turnChanges.js";
import { useConnectionEpoch } from "../../server/topics.js";

const LOAD_DELAY_MS = 120;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatCommitDate(seconds: number): string {
  return dateFormat.format(new Date(seconds * 1000));
}

export interface HistoryCommitState {
  detail: HistoryCommitDetail | null;
  files: DiffFile[];
  error: string;
}

export function useHistoryCommit(scope: HistoryScope, sha: string | null): HistoryCommitState {
  const [detail, setDetail] = useState<HistoryCommitDetail | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const failed = useRef(false);
  const epoch = useConnectionEpoch();

  useEffect(() => {
    if (failed.current) setRetry((value) => value + 1);
  }, [epoch]);

  useEffect(() => {
    setDetail(null);
    setError("");
    failed.current = false;
    if (!sha) return;
    let active = true;
    const timer = setTimeout(() => {
      window.cw.getHistoryCommit(scope, sha).then(
        (next) => {
          if (active) setDetail(next);
        },
        (reason: Error) => {
          if (!active) return;
          failed.current = true;
          setError(reason.message);
        }
      );
    }, LOAD_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [scope, sha, retry]);

  const files = useMemo(() => parseUnifiedDiff(detail?.patch ?? ""), [detail]);
  return { detail, files, error };
}

export function FileStats({ file }: { file: DiffFile }) {
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

export function HistoryFileDiff({
  files,
  path,
  missingNote,
  onOpenFile,
  onClose
}: {
  files: DiffFile[];
  path: string;
  missingNote: string;
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
      {!file && <div className="inspect-dfile-note">{missingNote}</div>}
      {file && <DiffLines file={file} />}
    </div>
  );
}
