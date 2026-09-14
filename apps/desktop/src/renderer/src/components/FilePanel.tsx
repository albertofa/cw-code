import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { DirEntry } from "../cw.js";
import { FileIcon } from "./fileIcons.js";
import { parseUnifiedDiff } from "./diffParser.js";

interface FileTreeProps {
  dir: string;
  depth: number;
  childrenByDir: Record<string, DirEntry[]>;
  dirErrors: Record<string, string>;
  loading: Set<string>;
  expanded: Set<string>;
  openFile: string | null;
  onToggleDir: (path: string) => void;
  onRetryDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function FileTree({
  dir,
  depth,
  childrenByDir,
  dirErrors,
  loading,
  expanded,
  openFile,
  onToggleDir,
  onRetryDir,
  onOpenFile
}: FileTreeProps) {
  const error = dirErrors[dir];
  if (error) {
    return (
      <div className="side-empty">
        Couldn’t list {dir || "files"}: {error}{" "}
        <button
          className="btn"
          style={{ fontSize: 11, padding: "2px 8px" }}
          onClick={() => onRetryDir(dir)}
        >
          Retry
        </button>
      </div>
    );
  }
  const entries = childrenByDir[dir];
  if (!entries) {
    return loading.has(dir) ? <div className="side-empty">loading…</div> : null;
  }
  if (entries.length === 0) {
    return dir === "" ? <div className="side-empty">No files.</div> : null;
  }
  return (
    <>
      {entries.map((entry) => {
        if (!entry.isDir) {
          return (
            <div
              key={entry.path}
              className={`tree-row${entry.path === openFile ? " active" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onOpenFile(entry.path)}
              title={entry.path}
            >
              <span className="tree-chevron" />
              <FileIcon name={entry.name} size={14} />
              <span className="tree-name">{entry.name}</span>
            </div>
          );
        }
        const open = expanded.has(entry.path);
        return (
          <div key={entry.path}>
            <div
              className="tree-row dir"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onToggleDir(entry.path)}
              title={entry.path}
            >
              <span className="tree-chevron">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
              <FileIcon name={entry.name} isDir expanded={open} size={14} />
              <span className="tree-name">{entry.name}</span>
            </div>
            {open && (
              <FileTree
                dir={entry.path}
                depth={depth + 1}
                childrenByDir={childrenByDir}
                dirErrors={dirErrors}
                loading={loading}
                expanded={expanded}
                openFile={openFile}
                onToggleDir={onToggleDir}
                onRetryDir={onRetryDir}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export function FilePanel({ sessionId }: { sessionId: string }) {
  const [childrenByDir, setChildrenByDir] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [filter, setFilter] = useState("");
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState("");
  const seqRef = useRef(0);
  const pendingRef = useRef<Set<string>>(new Set());

  const loadDir = useCallback((sid: string, seq: number, dir: string) => {
    const key = `${seq}:${dir}`;
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key);
    setLoading((prev) => new Set(prev).add(dir));
    window.cw
      .listDir(sid, dir || undefined)
      .then((entries) => {
        if (seqRef.current !== seq) return;
        setChildrenByDir((prev) => ({ ...prev, [dir]: entries }));
        setDirErrors((prev) => {
          if (!(dir in prev)) return prev;
          const next = { ...prev };
          delete next[dir];
          return next;
        });
      })
      .catch((err: Error) => {
        if (seqRef.current !== seq) return;
        setDirErrors((prev) => ({ ...prev, [dir]: err.message }));
      })
      .finally(() => {
        pendingRef.current.delete(key);
        if (seqRef.current !== seq) return;
        setLoading((prev) => {
          if (!prev.has(dir)) return prev;
          const next = new Set(prev);
          next.delete(dir);
          return next;
        });
      });
  }, []);

  useEffect(() => {
    seqRef.current += 1;
    const seq = seqRef.current;
    pendingRef.current.clear();
    setChildrenByDir({});
    setExpanded(new Set());
    setLoading(new Set());
    setDirErrors({});
    setOpenFile(null);
    setContent("");
    setAllFiles(null);
    setSearching(false);
    loadDir(sessionId, seq, "");
  }, [sessionId, loadDir]);

  useEffect(() => {
    if (!filter || allFiles !== null || searching) return;
    const seq = seqRef.current;
    const sid = sessionId;
    setSearching(true);
    window.cw
      .listFiles(sid)
      .then((files) => {
        if (seqRef.current !== seq) return;
        setAllFiles(files);
      })
      .catch((err: Error) => {
        if (seqRef.current !== seq) return;
        setStatus(`search failed: ${err.message}`);
      })
      .finally(() => {
        if (seqRef.current === seq) setSearching(false);
      });
  }, [filter, allFiles, searching, sessionId]);

  const toggleDir = (path: string) => {
    const isOpen = expanded.has(path);
    const next = new Set(expanded);
    if (isOpen) next.delete(path);
    else next.add(path);
    setExpanded(next);
    if (!isOpen && !childrenByDir[path] && !dirErrors[path]) loadDir(sessionId, seqRef.current, path);
  };

  const retryDir = (path: string) => {
    setDirErrors((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
    loadDir(sessionId, seqRef.current, path);
  };

  const open = (path: string) => {
    setOpenFile(path);
    window.cw
      .readFile(sessionId, path)
      .then(setContent)
      .catch((err: Error) => setStatus(`read failed: ${err.message}`));
  };

  const save = () => {
    if (!openFile) return;
    window.cw
      .saveFile(sessionId, openFile, content)
      .then(() => setStatus(`saved ${openFile}`))
      .catch((err: Error) => setStatus(`save failed: ${err.message}`));
  };

  const matches = filter
    ? (allFiles ?? []).filter((f) => f.toLowerCase().includes(filter.toLowerCase())).slice(0, 300)
    : null;

  return (
    <div className="file-layout">
      <div className="file-side">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter files…"
          className="field file-filter"
        />
        <div className="file-list">
          {filter ? (
            searching && allFiles === null ? (
              <div className="side-empty">searching all files…</div>
            ) : (
              <>
                {(matches ?? []).map((f) => (
                  <div
                    key={f}
                    onClick={() => open(f)}
                    className={`tree-row${f === openFile ? " active" : ""}`}
                    title={f}
                  >
                    <span className="tree-chevron" />
                    <FileIcon name={baseName(f)} size={14} />
                    <span className="tree-name">{baseName(f)}</span>
                  </div>
                ))}
                {matches && matches.length === 0 && <div className="side-empty">No matches.</div>}
              </>
            )
          ) : (
            <FileTree
              dir=""
              depth={0}
              childrenByDir={childrenByDir}
              dirErrors={dirErrors}
              loading={loading}
              expanded={expanded}
              openFile={openFile}
              onToggleDir={toggleDir}
              onRetryDir={retryDir}
              onOpenFile={open}
            />
          )}
        </div>
      </div>
      <div className="editor-col">
        <div className="editor-bar">
          <span className="path">{openFile ?? "no file open"}</span>
          {openFile && (
            <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={save}>
              Save
            </button>
          )}
          {status && <span className="status">{status}</span>}
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="editor"
        />
      </div>
    </div>
  );
}

const STATUS_BADGE: Record<string, string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  modified: "M"
};

export function DiffPanel({ sessionId }: { sessionId: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    setDiff(null);
    setCollapsed(new Set());
    window.cw
      .turnDiff(sessionId, Date.now() - 24 * 3600 * 1000)
      .then((d) => setDiff(d))
      .catch((err: Error) => setDiff(`diff unavailable: ${err.message}`));
  }, [sessionId]);

  if (diff == null) return <div className="diff-empty">loading…</div>;
  if (!diff || !diff.includes("diff --git")) {
    return <pre className="diff">{diff || "(clean — no changes)"}</pre>;
  }

  const files = parseUnifiedDiff(diff);
  const totalAdded = files.reduce((n, f) => n + f.added, 0);
  const totalRemoved = files.reduce((n, f) => n + f.removed, 0);

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="diff-list">
      <div className="diff-summary">
        {files.length} file{files.length === 1 ? "" : "s"} · <span className="add">+{totalAdded}</span>{" "}
        <span className="del">−{totalRemoved}</span>
      </div>
      {files.map((f) => {
        const shut = collapsed.has(f.path);
        return (
          <div key={f.path} className="diff-file">
            <div className="diff-head" onClick={() => toggle(f.path)} title={f.path}>
              <span className="tree-chevron">{shut ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
              <FileIcon name={baseName(f.path)} size={14} />
              <span className="diff-path">{f.path}</span>
              <span className={`diff-badge ${f.status}`}>{STATUS_BADGE[f.status]}</span>
              <span className="diff-stats">
                <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
              </span>
            </div>
            {!shut && (
              <div className="diff-body">
                {f.lines.map((l, i) => (
                  <div key={i} className={`diff-line ${l.type}`}>
                    <span className="diff-gutter">
                      {l.type === "add" ? "+" : l.type === "del" ? "−" : l.type === "hunk" ? "⋯" : ""}
                    </span>
                    <span className="diff-text">{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
