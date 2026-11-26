import { useMemo } from "react";
import { createPortal } from "react-dom";
import { GitCompareArrows, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import type { GitDiffMode, TurnSnapshot } from "@cw-code/contracts";
import type { GitStatus } from "../../cw.js";
import { MenuSelect } from "../MenuSelect.js";
import { shortenHome } from "../pathDisplay.js";
import { relativeTime } from "../prDetailModel.js";
import { useTurnUndo, type TurnUndo } from "../TurnChangesCard.js";
import { useGitStatus } from "../useGit.js";
import { DIFF_MODE_LABEL, DIFF_MODES, snapshotWarning, useLastTurnSnapshot, type GitDiffState } from "../useGitDiff.js";
import { useAppStore } from "../../stores/appStore.js";
import { usePanelStore } from "../../stores/panelStore.js";
import { FileRow } from "./CommitDetails.js";

function tabCount(mode: GitDiffMode, diff: GitDiffState, status: GitStatus | null, undo: TurnUndo): number | null {
  if (mode === diff.mode && diff.result) return diff.files.length;
  if (mode === "working") return status?.available ? status.dirtyCount : null;
  if (mode === "staged") return status?.available ? status.stagedCount : null;
  if (mode === "turn") return undo.changes ? undo.changes.files.length : null;
  return null;
}

function summaryAside(diff: GitDiffState, status: GitStatus | null, snapshot: TurnSnapshot | undefined, nowMs: number): string | null {
  if (diff.mode === "working" || diff.mode === "staged") return "vs HEAD";
  if (diff.mode === "branch") {
    if (!status?.available || !diff.result?.baseRef || status.baseRef !== diff.result.baseRef) return null;
    return `${status.baseAhead} ahead · ${status.baseBehind} behind`;
  }
  if (!snapshot) return null;
  return snapshot.endedAt ? `Ended ${relativeTime(snapshot.endedAt, nowMs)}` : `Started ${relativeTime(snapshot.capturedAt, nowMs)}`;
}

function undoDisabledReason(undo: TurnUndo): string | null {
  if (undo.blockers.length > 0) return undo.blockers[0] ?? null;
  if (undo.changes === null) return undo.entry?.error ? `Could not load this turn’s changes: ${undo.entry.error}` : "This turn’s changes are still loading";
  if (undo.changes.files.length === 0) return "This turn changed no files";
  return null;
}

function UndoTurn({ undo }: { undo: TurnUndo }) {
  const reason = undoDisabledReason(undo);
  const busy = undo.phase !== "idle";
  const label = undo.phase === "undoing" ? "Undoing…" : undo.phase === "checking" ? "Checking…" : "Undo this turn…";
  return (
    <section className="gg-d-sec" aria-label="Actions">
      <h4 className="gg-d-h">Actions</h4>
      <div className="gg-actions">
        <button
          type="button"
          className="gg-action danger"
          aria-disabled={reason !== null || busy || undefined}
          aria-busy={busy || undefined}
          title={reason ?? "Restore the files this turn changed"}
          onClick={() => {
            if (reason === null) void undo.undo();
          }}
        >
          <RotateCcw size={12} aria-hidden="true" />
          {label}
        </button>
      </div>
      {undo.blockers.map((blocker) => (
        <div key={blocker} className="gg-note gg-ch-blocker">
          {blocker}
        </div>
      ))}
      {undo.entry?.error && undo.changes === null && (
        <div className="gg-error-text">
          Could not load this turn’s changes: {undo.entry.error}{" "}
          <button type="button" className="gg-link" onClick={() => void undo.refresh()} disabled={undo.refreshing}>
            {undo.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      )}
    </section>
  );
}

export function ChangesDetails({
  sessionId,
  diff,
  onMode,
  openPath,
  onOpenFile
}: {
  sessionId: string;
  diff: GitDiffState;
  onMode: (mode: GitDiffMode) => void;
  openPath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const status = useGitStatus(sessionId);
  const snapshot = useLastTurnSnapshot(sessionId);
  const homeDir = useAppStore((s) => s.homeDir);
  const undo = useTurnUndo(sessionId, snapshot);
  const { mode, result, files, branches, baseRef, error, loading } = diff;
  const nowMs = useMemo(() => Date.now(), [result, mode]);
  const warning = snapshotWarning(snapshot, mode);
  const aside = summaryAside(diff, status, snapshot, nowMs);
  const conflicts = mode === "turn" && !undo.undone ? (undo.changes?.conflicts ?? []) : [];

  return (
    <div className="gg-changes">
      <div className="gg-ch-tabs" role="tablist" aria-label="Diff comparison">
        {DIFF_MODES.map((item) => {
          const unavailable = item === "turn" && !snapshot?.sha && mode !== "turn";
          const count = tabCount(item, diff, status, undo);
          return (
            <button
              key={item}
              type="button"
              role="tab"
              className={`gg-ch-tab${mode === item ? " on" : ""}`}
              aria-selected={mode === item}
              aria-disabled={unavailable || undefined}
              title={unavailable ? "No snapshot for the last turn" : undefined}
              onClick={() => {
                if (!unavailable) onMode(item);
              }}
            >
              {DIFF_MODE_LABEL[item]}
              {count !== null && <span className="gg-ch-count">{count}</span>}
            </button>
          );
        })}
        <button type="button" className="gg-icon-btn gg-ch-refresh" title="Refresh comparison" aria-label="Refresh comparison" onClick={diff.refresh}>
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>
      {warning && (
        <div className="gg-ch-warning" title={warning}>
          <TriangleAlert size={13} aria-hidden="true" />
          <span>{warning}</span>
        </div>
      )}
      {mode === "turn" && undo.undone && (
        <div className="gg-note gg-ch-undone" role="status">
          <RotateCcw size={12} aria-hidden="true" />
          These changes were undone
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="gg-ch-warning" role="status" title={conflicts.join(", ")}>
          <TriangleAlert size={13} aria-hidden="true" />
          <span>Changed since the turn ended: {conflicts.join(", ")}</span>
          <button type="button" className="gg-link" onClick={() => void undo.refresh()} disabled={undo.refreshing}>
            {undo.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      )}
      {mode === "branch" && branches.length > 0 && (
        <div className="gg-compare">
          <GitCompareArrows size={13} aria-hidden="true" />
          <MenuSelect
            label="Comparison branch"
            title="Compare this branch with another one"
            direction="down"
            value={baseRef ?? ""}
            display={branches.find((branch) => branch.name === baseRef)?.label ?? "Choose branch"}
            options={branches
              .filter((branch) => !branch.current)
              .map((branch) => ({
                id: branch.name,
                label: branch.label,
                hint: branch.name,
                description: branch.remote
                  ? "Remote branch"
                  : branch.worktreePath
                    ? `Worktree: ${shortenHome(branch.worktreePath, homeDir ?? undefined)}`
                    : undefined
              }))}
            onPick={diff.pickBase}
            searchable
            searchPlaceholder="Filter branches…"
          />
          <span className="gg-compare-sep">…</span>
          <span className="gg-compare-head">{result?.headRef ?? "HEAD"}</span>
        </div>
      )}
      {error && <div className="inspect-error gg-error">Git diff unavailable: {error}</div>}
      {!error && !result && <div className="gg-note">Loading comparison…</div>}
      {!error && result && files.length === 0 && (
        <div className="gg-note">
          No {DIFF_MODE_LABEL[mode].toLowerCase()} changes
          {mode === "branch" && result.baseRef ? ` — ${result.baseRef} and ${result.headRef} have no differing files.` : ""}
        </div>
      )}
      {!error && result && files.length > 0 && (
        <>
          <div className="gg-ch-summary">
            <span>
              {files.length} file{files.length === 1 ? "" : "s"}
            </span>
            <span className="add">+{diff.added}</span>
            <span className="del">−{diff.removed}</span>
            {loading && <span className="gg-ch-refreshing">Refreshing…</span>}
            {aside && <span className="gg-ch-aside">{aside}</span>}
          </div>
          <div className="gg-files" role="list" aria-label="Changed files">
            {files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                depth={null}
                shown={file.path === openPath}
                onOpen={() => onOpenFile(file.path)}
                onReveal={(path) => usePanelStore.getState().revealFile(sessionId, path)}
              />
            ))}
          </div>
        </>
      )}
      {mode === "turn" && snapshot?.sha && !undo.undone && <UndoTurn undo={undo} />}
      {undo.dialog && createPortal(undo.dialog, document.body)}
    </div>
  );
}
