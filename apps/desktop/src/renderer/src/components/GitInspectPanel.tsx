import { useEffect, useMemo, useState } from "react";
import { FileDiff, GitCompareArrows, Layers3, RefreshCw } from "lucide-react";
import type { GitBranchInfo, GitDiffMode, GitDiffResult } from "../cw.js";
import { FileIcon } from "./fileIcons.js";
import { MenuSelect } from "./MenuSelect.js";
import { parseUnifiedDiff } from "./diffParser.js";
import { useAppStore } from "../stores/appStore.js";
import { shortenHome } from "./pathDisplay.js";

const MODE_LABEL: Record<GitDiffMode, string> = {
  working: "Changes",
  staged: "Staged",
  branch: "Branch"
};

const STATUS_BADGE: Record<string, string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  modified: "M"
};

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

export function GitInspectPanel({ sessionId }: { sessionId: string }) {
  const [mode, setMode] = useState<GitDiffMode>("working");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [baseRef, setBaseRef] = useState<string>();
  const homeDir = useAppStore((s) => s.homeDir);
  const [result, setResult] = useState<GitDiffResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    setBaseRef(undefined);
    window.cw.listGitBranches(sessionId).then((items) => {
      if (!active) return;
      setBranches(items);
      const current = items.find((item) => item.current);
      const preferred = items.find((item) => ["main", "master", "origin/main", "origin/master"].includes(item.name) && !item.current)
        ?? items.find((item) => !item.current);
      if (!baseRef && preferred) setBaseRef(preferred.name);
      if (!preferred && current) setBaseRef(current.name);
    }).catch((reason: Error) => {
      if (active) setError(reason.message);
    });
    return () => { active = false; };
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    setResult(null);
    setError("");
    window.cw.getGitDiff(sessionId, mode, mode === "branch" ? baseRef : undefined).then((next) => {
      if (!active) return;
      setResult(next);
      if (next.baseRef && !baseRef) setBaseRef(next.baseRef);
    }).catch((reason: Error) => {
      if (active) setError(reason.message);
    });
    return () => { active = false; };
  }, [sessionId, mode, baseRef, refreshKey]);

  const files = useMemo(() => parseUnifiedDiff(result?.patch ?? ""), [result]);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);

  useEffect(() => {
    if (files.length === 0) setSelectedPath(null);
    else if (!selectedPath || !files.some((file) => file.path === selectedPath)) setSelectedPath(files[0].path);
  }, [result?.patch]);

  return (
    <div className="inspect">
      <div className="inspect-toolbar">
        <span className="inspect-title"><FileDiff size={14} /> Inspect</span>
        <div className="inspect-modes" role="tablist" aria-label="Diff comparison">
          {(Object.keys(MODE_LABEL) as GitDiffMode[]).map((item) => (
            <button
              key={item}
              className={`inspect-mode${mode === item ? " active" : ""}`}
              onClick={() => setMode(item)}
              role="tab"
              aria-selected={mode === item}
            >
              {item === "staged" && <Layers3 size={12} />}
              {item === "branch" && <GitCompareArrows size={12} />}
              {MODE_LABEL[item]}
            </button>
          ))}
        </div>
        <button className="icon-btn" title="Refresh comparison" onClick={() => setRefreshKey((value) => value + 1)}>
          <RefreshCw size={13} />
        </button>
      </div>
      {mode === "branch" && branches.length > 0 && (
        <div className="inspect-compare">
          <span>Compare</span>
          <MenuSelect
            label="Comparison branch"
            value={baseRef ?? ""}
            display={branches.find((branch) => branch.name === baseRef)?.label ?? "Choose branch"}
            options={branches.filter((branch) => !branch.current).map((branch) => ({
              id: branch.name,
              label: branch.label,
              hint: branch.name,
              description: branch.remote ? "Remote branch" : branch.worktreePath ? `Worktree: ${shortenHome(branch.worktreePath, homeDir ?? undefined)}` : undefined
            }))}
            onPick={setBaseRef}
            searchable
            searchPlaceholder="Filter branches…"
          />
          <span className="inspect-head-ref">… {result?.headRef ?? "HEAD"}</span>
        </div>
      )}
      {error && <div className="inspect-error">Git diff unavailable: {error}</div>}
      {!error && !result && <div className="diff-empty">Loading comparison…</div>}
      {!error && result && files.length === 0 && (
        <div className="inspect-empty">
          <FileDiff size={24} />
          <span>No {MODE_LABEL[mode].toLowerCase()} changes</span>
          {mode === "branch" && baseRef && <small>{baseRef} and {result.headRef} have no differing files.</small>}
        </div>
      )}
      {!error && result && files.length > 0 && (
        <>
          <div className="inspect-summary">
            <span>{files.length} file{files.length === 1 ? "" : "s"}</span>
            <span className="add">+{totalAdded}</span>
            <span className="del">−{totalRemoved}</span>
            {mode === "branch" && result.baseRef && <span className="inspect-range">{result.baseRef}…{result.headRef}</span>}
          </div>
          <div className="inspect-body">
            <div className="inspect-files" role="listbox" aria-label="Changed files">
              {files.map((file) => (
                <button
                  key={file.path}
                  className={`inspect-file${selected?.path === file.path ? " active" : ""}`}
                  onClick={() => setSelectedPath(file.path)}
                  title={file.path}
                  role="option"
                  aria-selected={selected?.path === file.path}
                >
                  <FileIcon name={baseName(file.path)} size={14} />
                  <span className="inspect-file-copy">
                    <span className="inspect-file-name">{baseName(file.path)}</span>
                    <span className="inspect-file-path">{file.path}</span>
                  </span>
                  <span className={`diff-badge ${file.status}`}>{STATUS_BADGE[file.status]}</span>
                  <span className="inspect-file-stats"><span className="add">+{file.added}</span> <span className="del">−{file.removed}</span></span>
                </button>
              ))}
            </div>
            <div className="inspect-diff">
              {selected && (
                <>
                  <div className="inspect-file-head">
                    <FileIcon name={baseName(selected.path)} size={14} />
                    <span>{selected.path}</span>
                    {selected.binary && <span className="inspect-binary">binary</span>}
                  </div>
                  <div className="diff-body inspect-lines">
                    {selected.lines.map((line, index) => (
                      <div key={index} className={`diff-line ${line.type}`}>
                        <span className="diff-number">{line.oldNumber ?? ""}</span>
                        <span className="diff-number">{line.newNumber ?? ""}</span>
                        <span className="diff-gutter">{line.type === "add" ? "+" : line.type === "del" ? "−" : line.type === "hunk" ? "⋯" : ""}</span>
                        <span className="diff-text">{line.text || " "}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
