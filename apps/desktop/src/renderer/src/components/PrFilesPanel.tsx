import { useEffect, useMemo, useState } from "react";
import { FileDiff } from "lucide-react";
import type { PrRef } from "../cw.js";
import { usePrStore } from "../stores/prStore.js";
import { prKey } from "./prInbox.js";
import { FileIcon } from "./fileIcons.js";
import { parseUnifiedDiff } from "./diffParser.js";

const STATUS_BADGE: Record<string, string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  modified: "M"
};

const MAX_DIFF_LINES = 3000;

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

export function PrFilesPanel({ prRef }: { prRef: PrRef }) {
  const key = prKey(prRef);
  const diff = usePrStore((s) => s.diffByKey[key]);
  const loading = usePrStore((s) => s.diffLoadingByKey[key] ?? false);
  const error = usePrStore((s) => s.diffErrorByKey[key]);
  const loadDiff = usePrStore((s) => s.loadDiff);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  useEffect(() => {
    if (diff === undefined && !loading && error === undefined) void loadDiff(prRef);
  }, [key, diff, loading, error, loadDiff, prRef]);

  const files = useMemo(() => parseUnifiedDiff(diff ?? ""), [diff]);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);

  if (error) {
    return (
      <div className="pr-files-error">
        <span>Diff unavailable: {error}</span>
        <button className="pr-detail-btn sm" onClick={() => void loadDiff(prRef, true)}>Retry</button>
      </div>
    );
  }
  if (diff === undefined) return <div className="pr-files-empty">Loading changed files…</div>;
  if (files.length === 0) return <div className="pr-files-empty">No changed files.</div>;

  const expanded = selected !== null && expandedPath === selected.path;
  const shownLines = selected ? (expanded ? selected.lines : selected.lines.slice(0, MAX_DIFF_LINES)) : [];
  const truncated = selected !== null && !expanded && selected.lines.length > MAX_DIFF_LINES;

  return (
    <div className="pr-files-layout">
      <div className="pr-files-tree" role="listbox" aria-label="Changed files">
        <div className="pr-files-summary">
          <span>{files.length} file{files.length === 1 ? "" : "s"}</span>
          <span className="add">+{totalAdded}</span>
          <span className="del">−{totalRemoved}</span>
        </div>
        {files.map((file) => (
          <button
            key={file.path}
            className={`pr-files-file${selected?.path === file.path ? " active" : ""}`}
            onClick={() => setSelectedPath(file.path)}
            title={file.path}
            role="option"
            aria-selected={selected?.path === file.path}
          >
            <FileIcon name={baseName(file.path)} size={14} />
            <span className="pr-files-file-copy">
              <span className="pr-files-file-name">{baseName(file.path)}</span>
              <span className="pr-files-file-path">{file.path}</span>
            </span>
            <span className={`diff-badge ${file.status}`}>{STATUS_BADGE[file.status]}</span>
            <span className="pr-files-file-stats"><span className="add">+{file.added}</span> <span className="del">−{file.removed}</span></span>
          </button>
        ))}
      </div>
      <div className="pr-files-diff">
        {selected && (
          <>
            <div className="pr-files-diff-head">
              <FileIcon name={baseName(selected.path)} size={14} />
              <span>{selected.path}</span>
              {selected.binary && <span className="pr-files-binary">binary</span>}
            </div>
            {selected.binary ? (
              <div className="pr-files-empty">Binary file not shown.</div>
            ) : (
              <div className="diff-body pr-files-lines">
                {shownLines.map((line, index) => (
                  <div key={index} className={`diff-line ${line.type}`}>
                    <span className="diff-number">{line.oldNumber ?? ""}</span>
                    <span className="diff-number">{line.newNumber ?? ""}</span>
                    <span className="diff-gutter">{line.type === "add" ? "+" : line.type === "del" ? "−" : line.type === "hunk" ? "⋯" : ""}</span>
                    <span className="diff-text">{line.text || " "}</span>
                  </div>
                ))}
              </div>
            )}
            {truncated && (
              <div className="pr-files-truncated">
                <span>Showing the first {MAX_DIFF_LINES} of {selected.lines.length} lines.</span>
                <button className="pr-detail-btn ghost sm" onClick={() => setExpandedPath(selected.path)}>Show all</button>
              </div>
            )}
          </>
        )}
        {!selected && (
          <div className="pr-files-empty">
            <FileDiff size={24} />
            <span>Select a file to view its diff</span>
          </div>
        )}
      </div>
    </div>
  );
}
