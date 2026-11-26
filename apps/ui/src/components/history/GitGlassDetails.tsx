import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { X } from "lucide-react";
import type { GitDiffMode, PrRef } from "@cw-code/contracts";
import { startWidthDrag } from "./usePersistedState.js";

export type GitGlassSelection =
  | { kind: "commit"; sha: string }
  | { kind: "changes"; mode: GitDiffMode }
  | { kind: "pr"; ref: PrRef }
  | { kind: "session"; sessionId: string }
  | { kind: "worktree"; path: string };

export const DETAILS_MIN_WIDTH = 300;
export const DETAILS_MAX_WIDTH = 640;
export const DETAILS_DEFAULT_WIDTH = 380;

const HEADERS: Record<GitGlassSelection["kind"], string> = {
  commit: "Commit",
  changes: "Changes",
  pr: "Pull request",
  session: "Session",
  worktree: "Worktree"
};

export function GitGlassDetails({
  selection,
  width,
  onResize,
  onReset,
  onClose,
  renderCommit,
  renderChanges
}: {
  selection: GitGlassSelection | null;
  width: number;
  onResize: (width: number, commit: boolean) => void;
  onReset: () => void;
  onClose: () => void;
  renderCommit: (sha: string) => ReactNode;
  renderChanges: (mode: GitDiffMode) => ReactNode;
}) {
  const begin = (event: ReactPointerEvent<HTMLDivElement>): void =>
    startWidthDrag(
      event,
      width,
      -1,
      (next) => onResize(next, false),
      (next) => onResize(next, true)
    );

  let body: ReactNode;
  if (selection === null) body = <div className="gg-note gg-details-empty">Select a commit to see its details.</div>;
  else if (selection.kind === "commit") body = renderCommit(selection.sha);
  else if (selection.kind === "changes") body = renderChanges(selection.mode);
  else body = <div className="gg-note gg-details-empty">Nothing to show here yet.</div>;

  return (
    <aside className="gg-details" style={{ width }} aria-label="Details">
      <div
        className="gg-resize gg-resize-left"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the details panel"
        title="Drag to resize (double-click resets)"
        onPointerDown={begin}
        onDoubleClick={onReset}
      />
      <div className="gg-d-head">
        <span>{selection ? HEADERS[selection.kind] : "Details"}</span>
        {selection && (
          <button type="button" className="gg-icon-btn gg-d-close" onClick={onClose} title="Close (Esc)" aria-label="Close the details">
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="gg-d-body">{body}</div>
    </aside>
  );
}
