import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useAppStore } from "../stores/appStore.js";
import { ipcErrorMessage } from "./ipcError.js";
import { keepLabel, mismatchSentence, sendHereLabel, type BranchMismatch } from "./sessionBranch.js";
import { useBranchMismatch } from "./useGit.js";
import { findSession } from "./useLinkedPr.js";
import { useThreadEntry } from "./useThread.js";

export function BranchMismatchDock({ sessionId }: { sessionId: string }) {
  const mismatch = useBranchMismatch(sessionId);
  const projectName = useAppStore((s) => {
    const projectId = findSession(s.sessionsByProject, sessionId)?.projectId;
    return s.projects.find((project) => project.id === projectId)?.name ?? "The project";
  });
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnBusy = useThreadEntry(sessionId, "turn") != null;
  const hasMismatch = mismatch !== null;

  useEffect(() => {
    if (!hasMismatch) setError(null);
  }, [hasMismatch]);

  if (!mismatch) return null;

  const switchBranch = async () => {
    setSwitching(true);
    setError(null);
    try {
      await window.cw.switchGitBranch(sessionId, mismatch.sessionBranch);
    } catch (err) {
      setError(`Could not switch to ${mismatch.sessionBranch}: ${ipcErrorMessage(err)}`);
    } finally {
      setSwitching(false);
    }
  };

  const keepFolderHead = async () => {
    setSwitching(true);
    setError(null);
    try {
      const kept = await window.cw.keepFolderHead(sessionId);
      if (kept === null) setError("Could not read the project's current git state.");
    } catch (err) {
      setError(`Could not keep ${mismatch.folderBranch}: ${ipcErrorMessage(err)}`);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <section className="pr-dock branch-dock" aria-label="Branch mismatch">
      <div className="pr-dock-head">
        <TriangleAlert size={14} className="pr-dock-head-icon warn" aria-hidden="true" />
        <span className="pr-dock-title branch-dock-title" title={mismatchSentence(projectName, mismatch)}>
          {mismatchSentence(projectName, mismatch)}
        </span>
        <span className="pr-dock-spacer" />
        <button
          className="pr-detail-btn primary sm"
          onClick={() => void switchBranch()}
          disabled={switching || turnBusy}
          title={turnBusy ? "Wait for the running turn to finish before switching branches" : undefined}
        >
          Switch to {mismatch.sessionBranch}
        </button>
        <button
          className="pr-detail-btn ghost sm"
          onClick={() => void keepFolderHead()}
          disabled={switching}
        >
          {keepLabel(mismatch)}
        </button>
      </div>
      {error && (
        <div className="pr-dock-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

export function BranchSendChoice({
  mismatch,
  busy,
  switchDisabled,
  error,
  onSwitchAndSend,
  onSendHere,
  onCancel
}: {
  mismatch: BranchMismatch;
  busy: boolean;
  switchDisabled: boolean;
  error: string | null;
  onSwitchAndSend: () => void;
  onSendHere: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="branch-choice" role="alertdialog" aria-label="Choose a branch before sending">
      <div className="branch-choice-text">
        Switch to <b>{mismatch.sessionBranch}</b> before sending?
      </div>
      <div className="branch-choice-actions">
        <button type="button" className="pr-detail-btn primary sm" onClick={onSwitchAndSend} disabled={busy || switchDisabled}>
          Switch and send
        </button>
        <button type="button" className="pr-detail-btn sm" onClick={onSendHere} disabled={busy}>
          {sendHereLabel(mismatch)}
        </button>
        <button type="button" className="pr-detail-btn ghost sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="branch-choice-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
