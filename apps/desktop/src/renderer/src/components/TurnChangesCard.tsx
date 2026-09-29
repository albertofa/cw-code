import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, FileDiff, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import type { TurnChanges, TurnFileChange, TurnSnapshot } from "../cw.js";
import { useConfirm } from "./ConfirmDialog.js";
import { useNotifs } from "./Notifications.js";
import { FileIcon } from "./fileIcons.js";
import { ipcErrorMessage } from "./ipcError.js";
import { snapshotKey, splitRepoPath, turnTotals } from "./turnChanges.js";
import { useAppStore } from "../stores/appStore.js";
import { usePanelStore } from "../stores/panelStore.js";
import "./turnChanges.css";

const CHANGE_BADGE: Record<TurnFileChange["change"], string> = {
  added: "A",
  deleted: "D",
  modified: "M"
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; changes: TurnChanges | null }
  | { status: "error"; message: string };

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function Warning({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="turn-changes-warn" role="status">
      <TriangleAlert size={13} aria-hidden="true" />
      <span className="turn-changes-warn-text">{children}</span>
      {onRetry && (
        <button type="button" className="turn-changes-icon" onClick={onRetry} title="Retry" aria-label="Retry loading changes">
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function UndoMessage({ files }: { files: TurnFileChange[] }) {
  return (
    <div className="turn-undo-confirm">
      <p>Added files are deleted; modified and deleted files go back to their exact bytes from before the turn.</p>
      <ul className="turn-undo-files">
        {files.map((file) => (
          <li key={file.path}>
            <span className={`diff-badge ${file.change}`}>{CHANGE_BADGE[file.change]}</span>
            <span className="turn-undo-path" title={file.path}>{file.path}</span>
            <span className="turn-undo-kind">{file.change}</span>
          </li>
        ))}
      </ul>
      <p>Work from before the turn is kept.</p>
      <p>Line-ending changes (autocrlf) made by tools during the turn are reverted too.</p>
      <p>Other sessions sharing this checkout are not considered beyond cw-code’s own busy check.</p>
    </div>
  );
}

export function TurnChangesCard({ sessionId, snapshot }: { sessionId: string; snapshot: TurnSnapshot }) {
  const key = snapshotKey(snapshot);
  const hasStart = Boolean(snapshot.sha);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [undoing, setUndoing] = useState(false);
  const [undoneLocally, setUndoneLocally] = useState(false);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    if (!hasStart) return;
    let active = true;
    window.cw
      .getTurnChanges(sessionId)
      .then((changes) => {
        if (active) setState({ status: "ready", changes });
      })
      .catch((err: unknown) => {
        if (active) setState({ status: "error", message: ipcErrorMessage(err) });
      });
    return () => {
      active = false;
    };
  }, [sessionId, key, hasStart, refresh]);

  const refetch = () => setRefresh((value) => value + 1);
  const changes = state.status === "ready" && state.changes?.turnId === snapshot.turnId ? state.changes : null;
  const undone = snapshot.undoneAt !== undefined || undoneLocally;

  const undo = async () => {
    const endSha = changes?.endSha;
    if (!changes || !endSha || !changes.undoable || undoing) return;
    const reviewed = changes;
    const ok = await confirm({
      danger: true,
      title: "Undo this turn's changes?",
      confirmLabel: "Undo changes",
      message: <UndoMessage files={reviewed.files} />
    });
    if (!ok) return;
    setUndoing(true);
    try {
      const result = await window.cw.undoTurn(sessionId, reviewed.turnId, endSha);
      setUndoneLocally(true);
      useNotifs.getState().push({
        kind: "success",
        title: "Turn changes undone",
        message: `${plural(result.files.length, "file")} restored to their state before the turn.`
      });
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title: "Could not undo this turn", message: ipcErrorMessage(err) });
    } finally {
      setUndoing(false);
      refetch();
      void useAppStore.getState().refreshGitStatus(sessionId);
    }
  };

  const review = () => usePanelStore.getState().requestDiffMode(sessionId, "turn");

  let body: ReactNode = null;
  if (snapshot.error) {
    body = <Warning>No change summary for this turn: the snapshot failed ({snapshot.error})</Warning>;
  } else if (state.status === "error") {
    body = <Warning onRetry={refetch}>Could not load this turn’s changes: {state.message}</Warning>;
  } else if (changes && changes.files.length === 0 && snapshot.endError) {
    body = <Warning>End-of-turn snapshot failed: {snapshot.endError}</Warning>;
  } else if (changes && changes.files.length > 0) {
    const totals = turnTotals(changes.files);
    const undoTitle = changes.undoable ? "Restore the files this turn changed" : changes.reason;
    body = (
      <div className="turn-changes">
        <div className="turn-changes-hd">
          <FileDiff size={14} aria-hidden="true" />
          <b>{plural(changes.files.length, "file")} changed</b>
          <span className="add">+{totals.added}</span>
          <span className="del">−{totals.deleted}</span>
          <span className="turn-changes-end">
            {undone ? (
              <span className="turn-changes-undone">
                <RotateCcw size={12} aria-hidden="true" />
                Changes undone
              </span>
            ) : (
              <span title={undoTitle}>
                <button
                  type="button"
                  className="btn turn-changes-btn"
                  onClick={() => void undo()}
                  disabled={!changes.undoable || undoing}
                >
                  {undoing ? "Undoing…" : "Undo"}
                </button>
              </span>
            )}
            <button type="button" className="btn turn-changes-btn" onClick={review} title="Review this turn in Git diff">
              Review
              <ChevronRight size={12} aria-hidden="true" />
            </button>
          </span>
        </div>
        {snapshot.endError && (
          <Warning>End-of-turn snapshot failed, showing changes up to now: {snapshot.endError}</Warning>
        )}
        {!undone && changes.conflicts.length > 0 && (
          <Warning>Changed since the turn ended: {changes.conflicts.join(", ")}</Warning>
        )}
        <div className="turn-changes-files">
          {changes.files.map((file) => {
            const { dir, name } = splitRepoPath(file.path);
            const deleted = file.change === "deleted";
            return (
              <button
                type="button"
                key={file.path}
                className="turn-changes-row"
                onClick={() => usePanelStore.getState().revealFile(sessionId, file.path)}
                disabled={deleted}
                title={deleted ? `${file.path} (deleted)` : `Open ${file.path} in Files`}
              >
                <span className={`diff-badge ${file.change}`}>{CHANGE_BADGE[file.change]}</span>
                <FileIcon name={name} size={13} />
                <span className="turn-changes-path">
                  {dir && <span className="turn-changes-dir">{dir}</span>}
                  <span className="turn-changes-name">{name}</span>
                </span>
                <span className="turn-changes-stat">
                  {file.binary ? (
                    "binary"
                  ) : (
                    <>
                      <span className="add">+{file.added}</span> <span className="del">−{file.deleted}</span>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <>
      {body}
      {dialog && createPortal(dialog, document.body)}
    </>
  );
}
