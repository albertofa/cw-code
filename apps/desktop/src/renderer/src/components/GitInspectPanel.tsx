import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ExternalLink, FileDiff, GitCompareArrows, History, Layers3, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import type { GitBranchInfo, GitDiffMode, GitDiffResult, GitStatus } from "../cw.js";
import { FileIcon } from "./fileIcons.js";
import { MenuSelect } from "./MenuSelect.js";
import { parseUnifiedDiff, type DiffFile } from "./diffParser.js";
import { useAppStore } from "../stores/appStore.js";
import { usePanelStore } from "../stores/panelStore.js";
import { shortenHome } from "./pathDisplay.js";
import { findSession } from "./useLinkedPr.js";
import { snapshotKey, splitRepoPath } from "./turnChanges.js";

const MODE_LABEL: Record<GitDiffMode, string> = {
  working: "Changes",
  staged: "Staged",
  branch: "Branch",
  turn: "Last turn"
};

const MODES: GitDiffMode[] = ["working", "staged", "branch", "turn"];

const STATUS_BADGE: Record<string, string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  modified: "M"
};

const EXPAND_ALL_LIMIT = 8;

export interface DiffStatusSummary {
  baseAhead?: number | null;
  stagedCount?: number | null;
}

export function resolveInitialDiffMode(status: DiffStatusSummary | null | undefined): GitDiffMode {
  if ((status?.baseAhead ?? 0) > 0) return "branch";
  if ((status?.stagedCount ?? 0) > 0) return "staged";
  return "working";
}

function statusSignature(status: GitStatus | null): string {
  if (!status) return "";
  return [
    status.available,
    status.branch,
    status.dirtyCount,
    status.addedLines,
    status.deletedLines,
    status.stagedCount,
    status.ahead,
    status.behind,
    status.baseAhead,
    status.baseBehind
  ].join("|");
}

function sameDiff(a: GitDiffResult, b: GitDiffResult): boolean {
  return a.patch === b.patch && a.baseRef === b.baseRef && a.headRef === b.headRef && a.mode === b.mode;
}

const DiffFileSection = memo(function DiffFileSection({
  file,
  open,
  onToggle,
  onReveal
}: {
  file: DiffFile;
  open: boolean;
  onToggle: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  const { dir, name } = splitRepoPath(file.path);
  const deleted = file.status === "deleted";
  return (
    <section className="inspect-dfile">
      <div className="inspect-dfh">
        <button type="button" className="inspect-dfh-toggle" onClick={() => onToggle(file.path)} aria-expanded={open} title={file.path}>
          <span className={`collapse-caret${open ? " open" : ""}`} aria-hidden="true"><ChevronRight size={12} /></span>
          <FileIcon name={name} size={13} />
          <span className="inspect-dfh-path">
            {dir && <span className="inspect-dfh-dir">{dir}</span>}
            <span className="inspect-dfh-name">{name}</span>
          </span>
        </button>
        <span className="inspect-dfh-end">
          <span className={`diff-badge ${file.status}`}>{STATUS_BADGE[file.status]}</span>
          {file.binary ? (
            <span className="inspect-binary">binary</span>
          ) : (
            <span className="inspect-dfh-stats"><span className="add">+{file.added}</span><span className="del">−{file.removed}</span></span>
          )}
          <button
            type="button"
            className="inspect-dfh-open"
            onClick={() => onReveal(file.path)}
            disabled={deleted}
            title={deleted ? "File was deleted" : "Open in Files"}
            aria-label={`Open ${file.path} in Files`}
          >
            <ExternalLink size={13} aria-hidden="true" />
          </button>
        </span>
      </div>
      {open && (
        <div className="diff-body inspect-lines">
          {file.lines.length === 0 && <div className="inspect-dfile-note">{file.binary ? "Binary file not shown" : "No textual changes"}</div>}
          {file.lines.map((line, index) => (
            <div key={index} className={`diff-line ${line.type}`}>
              <span className="diff-number">{line.oldNumber ?? ""}</span>
              <span className="diff-number">{line.newNumber ?? ""}</span>
              <span className="diff-gutter">{line.type === "add" ? "+" : line.type === "del" ? "−" : line.type === "hunk" ? "⋯" : ""}</span>
              <span className="diff-text">{line.text || " "}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
});

export function GitInspectPanel({ sessionId }: { sessionId: string }) {
  const [mode, setMode] = useState<GitDiffMode>("working");
  const [userPicked, setUserPicked] = useState(false);
  const [autoApplied, setAutoApplied] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [baseRef, setBaseRef] = useState<string>();
  const homeDir = useAppStore((s) => s.homeDir);
  const status = useAppStore((s) => s.gitStatusBySession[sessionId] ?? null);
  const refreshGitStatus = useAppStore((s) => s.refreshGitStatus);
  const snapshot = useAppStore((s) => findSession(s.sessionsByProject, sessionId)?.lastTurnSnapshot);
  const diffModeRequest = usePanelStore((s) => s.diffModeRequest);
  const clearDiffModeRequest = usePanelStore((s) => s.clearDiffModeRequest);
  const clearStaleDiffModeRequest = usePanelStore((s) => s.clearStaleDiffModeRequest);
  const [loaded, setLoaded] = useState<{ scope: string; result: GitDiffResult } | null>(null);
  const [loading, setLoading] = useState(false);
  const [openByPath, setOpenByPath] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const handledRequestRef = useRef(0);
  const hasTurnSnapshot = Boolean(snapshot?.sha);
  const turnKey = mode === "turn" ? snapshotKey(snapshot) : "";
  const requestBase = mode === "branch" ? baseRef : undefined;
  const statusKey = statusSignature(status);
  const undoneAt = snapshot?.undoneAt;
  const scope = [sessionId, mode, requestBase ?? "", mode === "turn" ? snapshot?.turnId ?? "" : ""].join("|");
  const result = loaded?.scope === scope ? loaded.result : null;

  const pickMode = (next: GitDiffMode) => {
    setUserPicked(true);
    setAutoApplied(true);
    setMode(next);
  };

  useEffect(() => {
    let active = true;
    setMode("working");
    setUserPicked(false);
    setAutoApplied(false);
    setBaseRef(undefined);
    setBranches([]);
    void refreshGitStatus(sessionId);
    window.cw.listGitBranches(sessionId).then((items) => {
      if (!active) return;
      setBranches(items);
      const current = items.find((item) => item.current);
      const preferred = items.find((item) => ["main", "master", "origin/main", "origin/master"].includes(item.name) && !item.current)
        ?? items.find((item) => !item.current);
      setBaseRef((prev) => {
        if (prev) return prev;
        if (preferred) return preferred.name;
        if (current) return current.name;
        return prev;
      });
    }).catch((reason: Error) => {
      if (active) setError(reason.message);
    });
    return () => { active = false; };
  }, [sessionId, refreshGitStatus]);

  useEffect(() => {
    if (!diffModeRequest) return;
    if (diffModeRequest.sessionId !== sessionId) {
      clearStaleDiffModeRequest(sessionId);
      return;
    }
    if (diffModeRequest.nonce === handledRequestRef.current) return;
    handledRequestRef.current = diffModeRequest.nonce;
    pickMode(diffModeRequest.mode);
    clearDiffModeRequest(diffModeRequest.nonce);
  }, [diffModeRequest, sessionId, clearDiffModeRequest, clearStaleDiffModeRequest]);

  useEffect(() => {
    if (userPicked || autoApplied || !status) return;
    const next = resolveInitialDiffMode(status);
    if (next !== "working") setMode(next);
    if (status.baseRef) setBaseRef((prev) => prev ?? status.baseRef ?? prev);
    setAutoApplied(true);
  }, [status, userPicked, autoApplied]);

  useEffect(() => {
    setOpenByPath({});
  }, [sessionId, mode]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    window.cw.getGitDiff(sessionId, mode, requestBase).then((next) => {
      if (!active) return;
      setLoaded((prev) => (prev && prev.scope === scope && sameDiff(prev.result, next) ? prev : { scope, result: next }));
      if (mode === "branch" && next.baseRef) setBaseRef((prev) => prev ?? next.baseRef ?? prev);
    }).catch((reason: Error) => {
      if (active) setError(reason.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [sessionId, mode, requestBase, scope, refreshKey, turnKey, statusKey, undoneAt]);

  const files = useMemo(() => parseUnifiedDiff(result?.patch ?? ""), [result]);
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);
  const defaultOpen = files.length <= EXPAND_ALL_LIMIT;
  const toggleFile = useCallback((path: string) => {
    setOpenByPath((prev) => ({ ...prev, [path]: !(prev[path] ?? defaultOpen) }));
  }, [defaultOpen]);
  const revealFile = useCallback((path: string) => usePanelStore.getState().revealFile(sessionId, path), [sessionId]);
  const snapshotWarning = snapshot?.error
    ? `Last-turn snapshot failed: ${snapshot.error}`
    : mode === "turn" && snapshot?.endError
      ? `End-of-turn snapshot failed, showing changes up to now: ${snapshot.endError}`
      : "";

  return (
    <div className="inspect" aria-busy={loading || undefined}>
      <div className="inspect-toolbar">
        <span className="inspect-title"><FileDiff size={14} /> Git diff</span>
        <div className="inspect-modes" role="tablist" aria-label="Diff comparison">
          {MODES.map((item) => {
            const unavailable = item === "turn" && !hasTurnSnapshot && mode !== "turn";
            return (
              <button
                key={item}
                className={`inspect-mode${mode === item ? " active" : ""}`}
                onClick={() => {
                  if (!unavailable) pickMode(item);
                }}
                role="tab"
                aria-selected={mode === item}
                aria-disabled={unavailable || undefined}
                title={unavailable ? "No snapshot for the last turn" : undefined}
              >
                {item === "staged" && <Layers3 size={12} />}
                {item === "branch" && <GitCompareArrows size={12} />}
                {item === "turn" && <History size={12} />}
                {MODE_LABEL[item]}
              </button>
            );
          })}
        </div>
        <button className="icon-btn" title="Refresh comparison" onClick={() => setRefreshKey((value) => value + 1)}>
          <RefreshCw size={13} />
        </button>
      </div>
      {snapshotWarning && (
        <div className="inspect-warning" title={snapshotWarning}>
          <TriangleAlert size={13} aria-hidden="true" />
          <span>{snapshotWarning}</span>
        </div>
      )}
      {mode === "turn" && undoneAt !== undefined && (
        <div className="inspect-note" role="status">
          <RotateCcw size={12} aria-hidden="true" />
          <span>These changes were undone</span>
        </div>
      )}
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
            onPick={(name) => {
              setUserPicked(true);
              setAutoApplied(true);
              setBaseRef(name);
            }}
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
            {loading && <span className="inspect-refreshing">Refreshing…</span>}
            {mode === "branch" && result.baseRef && <span className="inspect-range">{result.baseRef}…{result.headRef}</span>}
          </div>
          <div className="inspect-stack">
            {files.map((file) => (
              <DiffFileSection
                key={file.path}
                file={file}
                open={openByPath[file.path] ?? defaultOpen}
                onToggle={toggleFile}
                onReveal={revealFile}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
