import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useBranchStore } from "../stores/branchStore.js";
import { ipcErrorMessage } from "./ipcError.js";
import type { BranchMismatch } from "./sessionBranch.js";
import { useBranchMismatch } from "./useBranchMismatch.js";

function MismatchText({ projectName, mismatch }: { projectName: string; mismatch: BranchMismatch }) {
  return (
    <>
      {projectName} is on <b>{mismatch.folderBranch}</b>, not this session's branch <b>{mismatch.sessionBranch}</b>.
    </>
  );
}

export function BranchMismatchDock({ sessionId }: { sessionId: string }) {
  const { mismatch, projectName } = useBranchMismatch(sessionId);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!mismatch) return null;

  const switchBranch = async () => {
    setSwitching(true);
    setError(null);
    try {
      await useBranchStore.getState().switchToSessionBranch(sessionId, mismatch.sessionBranch);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <section className="pr-dock branch-dock" aria-label="Branch mismatch">
      <div className="pr-dock-head">
        <TriangleAlert size={14} className="pr-dock-head-icon warn" aria-hidden="true" />
        <span className="pr-dock-title branch-dock-title" title={`${projectName} is on ${mismatch.folderBranch}`}>
          <MismatchText projectName={projectName} mismatch={mismatch} />
        </span>
        <span className="pr-dock-spacer" />
        <button className="pr-detail-btn primary sm" onClick={() => void switchBranch()} disabled={switching}>
          Switch to {mismatch.sessionBranch}
        </button>
        <button
          className="pr-detail-btn ghost sm"
          onClick={() => useBranchStore.getState().keepFolderBranch(sessionId, mismatch.folderBranch)}
          disabled={switching}
        >
          Keep working on {mismatch.folderBranch}
        </button>
      </div>
      {error && (
        <div className="pr-dock-error" role="alert">
          Could not switch to {mismatch.sessionBranch}: {error}
        </div>
      )}
    </section>
  );
}

export function BranchSendChoice({
  projectName,
  mismatch,
  busy,
  error,
  onSwitchAndSend,
  onSendHere,
  onCancel
}: {
  projectName: string;
  mismatch: BranchMismatch;
  busy: boolean;
  error: string | null;
  onSwitchAndSend: () => void;
  onSendHere: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="branch-choice" role="alertdialog" aria-label="Choose a branch before sending">
      <div className="branch-choice-text">
        <MismatchText projectName={projectName} mismatch={mismatch} />
      </div>
      <div className="branch-choice-actions">
        <button type="button" className="pr-detail-btn primary sm" onClick={onSwitchAndSend} disabled={busy}>
          Switch and send
        </button>
        <button type="button" className="pr-detail-btn sm" onClick={onSendHere} disabled={busy}>
          Send on {mismatch.folderBranch}
        </button>
        <button type="button" className="pr-detail-btn ghost sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="branch-choice-error" role="alert">
          Could not switch to {mismatch.sessionBranch}: {error}
        </div>
      )}
    </div>
  );
}
