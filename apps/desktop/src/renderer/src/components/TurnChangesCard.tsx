import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, FileDiff, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import type { TurnChanges, TurnFileChange, TurnSnapshot } from "../cw.js";
import { useConfirm } from "./ConfirmDialog.js";
import { useNotifs } from "./Notifications.js";
import { FileIcon } from "./fileIcons.js";
import { ipcErrorMessage, isFileNotFound } from "./ipcError.js";
import { sameRootSessionIds, snapshotKey, splitRepoPath, turnTotals } from "./turnChanges.js";
import { useAppStore } from "../stores/appStore.js";
import { buffersForPaths, isDirtyBuffer, useEditorBuffers, type EditorBuffer } from "../stores/editorBuffers.js";
import { usePanelStore } from "../stores/panelStore.js";
import "./turnChanges.css";

const CHANGE_BADGE: Record<TurnFileChange["change"], string> = {
  added: "A",
  deleted: "D",
  modified: "M"
};

const CACHE_TTL_MS = 30_000;
const TURN_RUNNING = "A turn is running";

const changesCache = new Map<string, { at: number; changes: TurnChanges | null }>();

type LoadState =
  | { status: "loading" }
  | { status: "ready"; changes: TurnChanges | null }
  | { status: "error"; message: string };

type UndoPhase = "idle" | "checking" | "undoing";

function cacheId(sessionId: string, key: string): string {
  return `${sessionId}\n${key}`;
}

function cachedChanges(sessionId: string, key: string): TurnChanges | null | undefined {
  const entry = changesCache.get(cacheId(sessionId, key));
  if (!entry || Date.now() - entry.at > CACHE_TTL_MS) return undefined;
  return entry.changes;
}

function cacheChanges(sessionId: string, key: string, changes: TurnChanges | null): void {
  const now = Date.now();
  for (const [id, entry] of changesCache) {
    if (now - entry.at > CACHE_TTL_MS) changesCache.delete(id);
  }
  changesCache.set(cacheId(sessionId, key), { at: now, changes });
}

function initialState(sessionId: string, key: string): LoadState {
  const cached = cachedChanges(sessionId, key);
  return cached === undefined ? { status: "loading" } : { status: "ready", changes: cached };
}

function dirtyPaths(buffers: Record<string, EditorBuffer>, sessionIds: readonly string[], files: readonly TurnFileChange[]): string[] {
  const matched = buffersForPaths(buffers, sessionIds, files.map((file) => file.path));
  return [...new Set(matched.filter(({ buffer }) => isDirtyBuffer(buffer)).map(({ buffer }) => buffer.path))].sort();
}

function undoBlockers(changes: TurnChanges, running: boolean, dirty: readonly string[]): string[] {
  const blockers: string[] = [];
  if (running) blockers.push(TURN_RUNNING);
  if (!changes.undoable) blockers.push(changes.reason ?? "This turn can’t be undone");
  else if (!changes.endSha) blockers.push("The end-of-turn snapshot is missing");
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
        const text = await window.cw.readFile(buffer.sessionId, buffer.path);
        useEditorBuffers.getState().reloadClean(key, text);
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
      <p>Work from before the turn is kept. Git-ignored files are left untouched.</p>
      <p>Line-ending changes (autocrlf) made by tools during the turn are reverted too.</p>
      <p>Other sessions working in this same folder aren’t checked beyond cw-code’s own busy check.</p>
    </div>
  );
}

export function TurnChangesCard({ sessionId, snapshot }: { sessionId: string; snapshot: TurnSnapshot }) {
  const key = snapshotKey(snapshot);
  const hasStart = Boolean(snapshot.sha);
  const [state, setState] = useState<LoadState>(() => initialState(sessionId, key));
  const [refresh, setRefresh] = useState(0);
  const [phase, setPhase] = useState<UndoPhase>("idle");
  const [undoneLocally, setUndoneLocally] = useState(false);
  const turnRunning = useAppStore((s) => s.busyTurns[sessionId] !== undefined);
  const rootIdsKey = useAppStore((s) => sameRootSessionIds(s.sessionsByProject, s.projects, sessionId).join("\n"));
  const rootIds = rootIdsKey.split("\n");
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    if (!hasStart) return;
    if (refresh === 0) {
      const cached = cachedChanges(sessionId, key);
      if (cached !== undefined) {
        setState({ status: "ready", changes: cached });
        return;
      }
    }
    let active = true;
    window.cw
      .getTurnChanges(sessionId)
      .then((changes) => {
        cacheChanges(sessionId, key, changes);
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
  const dirtyKey = useEditorBuffers((s) => (changes ? dirtyPaths(s.buffers, rootIds, changes.files).join("\n") : ""));
  const dirty = dirtyKey ? dirtyKey.split("\n") : [];

  const currentBlockers = (reviewed: TurnChanges) =>
    undoBlockers(
      reviewed,
      useAppStore.getState().busyTurns[sessionId] !== undefined,
      dirtyPaths(useEditorBuffers.getState().buffers, rootIds, reviewed.files)
    );

  const undo = async () => {
    if (phase !== "idle") return;
    setPhase("checking");
    let fresh: TurnChanges | null;
    try {
      fresh = await window.cw.getTurnChanges(sessionId);
    } catch (err) {
      const message = ipcErrorMessage(err);
      setState({ status: "error", message });
      useNotifs.getState().push({ kind: "error", title: "Could not undo this turn", message });
      setPhase("idle");
      return;
    }
    cacheChanges(sessionId, key, fresh);
    setState({ status: "ready", changes: fresh });
    const endSha = fresh?.endSha;
    if (!fresh || !endSha || fresh.turnId !== snapshot.turnId || currentBlockers(fresh).length > 0) {
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
    const blockers = undone ? [] : undoBlockers(changes, turnRunning, dirty);
    const busy = phase !== "idle";
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
