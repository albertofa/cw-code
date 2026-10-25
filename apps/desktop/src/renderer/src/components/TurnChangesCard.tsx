import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, FileDiff, RotateCcw, TriangleAlert } from "lucide-react";
import type { TurnChanges, TurnFileChange, TurnSnapshot } from "../cw.js";
import { useConfirm } from "./ConfirmDialog.js";
import { useNotifs } from "./Notifications.js";
import { FileIcon } from "./fileIcons.js";
import { ipcErrorMessage, isFileNotFound } from "./ipcError.js";
import { splitRepoPath, turnTotals } from "./turnChanges.js";
import { isThreadBusy, useThreadEntry } from "./useThread.js";
import { buffersForPaths, isDirtyBuffer, useEditorBuffers, type EditorBuffer } from "../stores/editorBuffers.js";
import { usePanelStore } from "../stores/panelStore.js";
import "./turnChanges.css";

const CHANGE_BADGE: Record<TurnFileChange["change"], string> = {
  added: "A",
  deleted: "D",
  modified: "M"
};

const TURN_RUNNING = "A turn is running";
const TURN_UNAVAILABLE = "This turn’s changes are no longer available";
const MISSING_END_SNAPSHOT = "The end-of-turn snapshot is missing";

type UndoPhase = "idle" | "checking" | "undoing";

function dirtyPaths(buffers: Record<string, EditorBuffer>, sessionIds: readonly string[], files: readonly TurnFileChange[]): string[] {
  const matched = buffersForPaths(buffers, sessionIds, files.map((file) => file.path));
  return [...new Set(matched.filter(({ buffer }) => isDirtyBuffer(buffer)).map(({ buffer }) => buffer.path))].sort();
}

function undoBlockers(changes: TurnChanges, running: boolean, dirty: readonly string[]): string[] {
  const blockers: string[] = [];
  if (running) blockers.push(TURN_RUNNING);
  if (!changes.undoable) blockers.push(changes.reason ?? "This turn can’t be undone");
  else if (!changes.endSha) blockers.push(MISSING_END_SNAPSHOT);
  if (dirty.length > 0) blockers.push(`Save or discard unsaved edits first: ${dirty.join(", ")}`);
  return blockers;
}

async function reloadRestoredBuffers(sessionIds: readonly string[], files: readonly TurnFileChange[]): Promise<void> {
  const store = useEditorBuffers.getState();
  const clean = buffersForPaths(store.buffers, sessionIds, files.map((file) => file.path)).filter(({ buffer }) => !isDirtyBuffer(buffer));
  const failures: string[] = [];
  await Promise.all(
    clean.map(async ({ key, buffer }) => {
      try {
        const info = await window.cw.readFileInfo(buffer.sessionId, buffer.path);
        if (info.kind === "text") useEditorBuffers.getState().reloadClean(key, info.content, info.mtimeMs);
        else if (info.kind === "missing") useEditorBuffers.getState().markMissing(key);
      } catch (err) {
        if (isFileNotFound(err)) useEditorBuffers.getState().markMissing(key);
        else failures.push(`${buffer.path}: ${ipcErrorMessage(err)}`);
      }
    })
  );
  if (failures.length > 0) {
    useNotifs.getState().push({
      kind: "error",
      title: "Could not reload open files after undo",
      message: `Reopen them before editing: ${failures.join("; ")}`
    });
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function Warning({ children, onRefresh, refreshing }: { children: ReactNode; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <div className="turn-changes-warn" role="status">
      <TriangleAlert size={13} aria-hidden="true" />
      <span className="turn-changes-warn-text">{children}</span>
      {onRefresh && (
        <button type="button" className="btn turn-changes-btn" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
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
      <p>Work from before the turn is kept. Git-ignored files are left untouched.</p>
      <p>Line-ending changes (autocrlf) made by tools during the turn are reverted too.</p>
      <p>Other sessions working in this same folder aren’t checked beyond cw-code’s own busy check.</p>
    </div>
  );
}

export function TurnChangesCard({ sessionId, snapshot }: { sessionId: string; snapshot: TurnSnapshot }) {
  const [phase, setPhase] = useState<UndoPhase>("idle");
  const [undoneLocally, setUndoneLocally] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const turnRunning = useThreadEntry(sessionId, "turn") != null;
  const entry = useThreadEntry(sessionId, "turnChanges") ?? null;
  const rootIds = entry?.rootSessionIds ?? [sessionId];
  const { confirm, dialog } = useConfirm();

  const changes = entry?.changes?.turnId === snapshot.turnId ? entry.changes : null;
  const undone = snapshot.undoneAt !== undefined || undoneLocally;
  const dirtyKey = useEditorBuffers((s) => (changes ? dirtyPaths(s.buffers, rootIds, changes.files).join("\n") : ""));
  const dirty = dirtyKey ? dirtyKey.split("\n") : [];

  const currentBlockers = (reviewed: TurnChanges) =>
    undoBlockers(
      reviewed,
      isThreadBusy(sessionId),
      dirtyPaths(useEditorBuffers.getState().buffers, rootIds, reviewed.files)
    );

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await window.cw.getTurnChanges(sessionId);
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title: "Could not refresh this turn’s changes", message: ipcErrorMessage(err) });
    } finally {
      setRefreshing(false);
    }
  };

  const undo = async () => {
    if (phase !== "idle") return;
    setPhase("checking");
    let fresh: TurnChanges | null;
    try {
      fresh = await window.cw.getTurnChanges(sessionId);
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title: "Could not undo this turn", message: ipcErrorMessage(err) });
      setPhase("idle");
      return;
    }
    const endSha = fresh?.endSha;
    const blockedBy = !fresh || fresh.turnId !== snapshot.turnId ? [TURN_UNAVAILABLE] : currentBlockers(fresh);
    if (!fresh || !endSha || blockedBy.length > 0) {
      const reasons = blockedBy.length > 0 ? blockedBy : [MISSING_END_SNAPSHOT];
      useNotifs.getState().push({ kind: "error", title: "Could not undo this turn", message: reasons.join(". ") });
      setPhase("idle");
      return;
    }
    const reviewed = fresh;
    const ok = await confirm({
      danger: true,
      title: "Undo this turn's changes?",
      confirmLabel: "Undo changes",
      message: <UndoMessage files={reviewed.files} />
    });
    if (!ok) {
      setPhase("idle");
      return;
    }
    const late = currentBlockers(reviewed);
    if (late.length > 0) {
      useNotifs.getState().push({ kind: "error", title: "Could not undo this turn", message: late.join(". ") });
      setPhase("idle");
      return;
    }
    setPhase("undoing");
    try {
      const result = await window.cw.undoTurn(sessionId, reviewed.turnId, endSha);
      setUndoneLocally(true);
      useNotifs.getState().push({
        kind: "success",
        title: "Turn changes undone",
        message: `${plural(result.files.length, "file")} restored to their state before the turn.`
      });
      const byPath = new Map([...reviewed.files, ...result.files].map((file) => [file.path, file]));
      await reloadRestoredBuffers(rootIds, [...byPath.values()]);
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title: "Could not undo this turn", message: ipcErrorMessage(err) });
    } finally {
      setPhase("idle");
    }
  };

  const review = () => usePanelStore.getState().requestDiffMode(sessionId, "turn");

  let body: ReactNode = null;
  if (snapshot.error) {
    body = <Warning>No change summary for this turn: the snapshot failed ({snapshot.error})</Warning>;
  } else if (entry?.error && entry.turnId === snapshot.turnId) {
    body = (
      <Warning onRefresh={() => void refresh()} refreshing={refreshing}>
        Could not load this turn’s changes: {entry.error}
      </Warning>
    );
  } else if (changes && changes.files.length === 0 && snapshot.endError) {
    body = <Warning>End-of-turn snapshot failed: {snapshot.endError}</Warning>;
  } else if (changes && changes.files.length > 0) {
    const totals = turnTotals(changes.files);
    const blockers = undone ? [] : undoBlockers(changes, turnRunning, dirty);
    const busy = phase !== "idle";
    body = (
      <div className="turn-changes">
        <div className="turn-changes-hd">
          <button
            type="button"
            className="turn-changes-toggle"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            title={expanded ? "Hide changed files" : "Show changed files"}
          >
            <ChevronRight size={13} className="turn-changes-chevron" aria-hidden="true" />
            <FileDiff size={14} aria-hidden="true" />
            <b>{plural(changes.files.length, "file")} changed</b>
            <span className="add">+{totals.added}</span>
            <span className="del">−{totals.deleted}</span>
          </button>
          <span className="turn-changes-end">
            {undone ? (
              <span className="turn-changes-undone">
                <RotateCcw size={12} aria-hidden="true" />
                Changes undone
              </span>
            ) : (
              <span title={blockers[0] ?? "Restore the files this turn changed"}>
                <button
                  type="button"
                  className="btn turn-changes-btn"
                  onClick={() => void undo()}
                  disabled={blockers.length > 0}
                  aria-busy={busy || undefined}
                >
                  {phase === "undoing" ? "Undoing…" : phase === "checking" ? "Checking…" : "Undo"}
                </button>
              </span>
            )}
            <button type="button" className="btn turn-changes-btn" onClick={review} title="Review this turn in Git diff">
              Review
              <ChevronRight size={12} aria-hidden="true" />
            </button>
          </span>
        </div>
        {blockers.map((blocker) => (
          <div key={blocker} className="turn-changes-note">{blocker}</div>
        ))}
        {snapshot.endError && (
          <Warning>End-of-turn snapshot failed, showing changes up to now: {snapshot.endError}</Warning>
        )}
        {!undone && changes.conflicts.length > 0 && (
          <Warning onRefresh={() => void refresh()} refreshing={refreshing}>
            Changed since the turn ended: {changes.conflicts.join(", ")}
          </Warning>
        )}
        {expanded && <div className="turn-changes-files">
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
        </div>}
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
