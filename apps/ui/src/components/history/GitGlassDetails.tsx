import type { ReactNode } from "react";
import { X } from "lucide-react";
import type { GitDiffMode, PrRef } from "@cw-code/contracts";
import { ResizeHandle } from "./ResizeHandle.js";

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
  renderChanges,
  renderPr,
  renderSession,
  renderWorktree
}: {
  selection: GitGlassSelection | null;
  width: number;
  onResize: (width: number, commit: boolean) => void;
  onReset: () => void;
  onClose: () => void;
  renderCommit: (sha: string) => ReactNode;
  renderChanges: (mode: GitDiffMode) => ReactNode;
  renderPr: (ref: PrRef) => ReactNode;
  renderSession: (sessionId: string) => ReactNode;
  renderWorktree: (path: string) => ReactNode;
}) {
  let body: ReactNode;
  if (selection === null) body = <div className="gg-note gg-details-empty">Select a commit, or a session, pull request or worktree in the sidebar.</div>;
  else if (selection.kind === "commit") body = renderCommit(selection.sha);
  else if (selection.kind === "changes") body = renderChanges(selection.mode);
  else if (selection.kind === "pr") body = renderPr(selection.ref);
  else if (selection.kind === "session") body = renderSession(selection.sessionId);
  else body = renderWorktree(selection.path);

  return (
    <aside className="gg-details" style={{ width }} aria-label="Details">
      <ResizeHandle
        className="gg-resize gg-resize-left"
        label="Resize the details panel"
        value={width}
        min={DETAILS_MIN_WIDTH}
        max={DETAILS_MAX_WIDTH}
        direction={-1}
        onChange={onResize}
        onReset={onReset}
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
