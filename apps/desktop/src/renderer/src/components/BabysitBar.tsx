import { useState } from "react";
import { Activity, ExternalLink, Pause, Play, Square } from "lucide-react";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { babysitStatusText } from "./prSessionModel.js";
import { prRefLabel } from "./sessionPrLinks.js";
import { useBabysitStates } from "./useBabysit.js";
import { findSession } from "./useLinkedPr.js";
import { ipcErrorMessage } from "./ipcError.js";

export function BabysitBar({ sessionId }: { sessionId: string }) {
  const session = useAppStore((s) => findSession(s.sessionsByProject, sessionId));
  const pause = useAppStore((s) => s.pauseAutoFollowUp);
  const resume = useAppStore((s) => s.resumeAutoFollowUp);
  const applySession = useAppStore((s) => s.applySession);
  const openPr = usePrStore((s) => s.openPr);
  const stateOf = useBabysitStates();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = session ? stateOf(session) : null;
  if (!state) return null;

  const { link, workflow, phase } = state;
  const paused = phase.kind === "paused";

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setError(null);
    const { workflowId: _workflowId, ...rest } = link;
    try {
      applySession(await window.cw.linkSessionPr(sessionId, rest));
      resume(sessionId);
    } catch (err) {
      setError(`Could not stop ${workflow.label}: ${ipcErrorMessage(err)}`);
    } finally {
      setStopping(false);
    }
  };

  return (
    <section className={`pr-dock babysit-bar${paused ? " paused" : ""}`} aria-label={`${workflow.label} mode`}>
      <div className="pr-dock-head">
        <Activity size={14} className={`babysit-icon ${phase.kind}`} aria-hidden="true" />
        <span className="pr-dock-title">
          {workflow.label} · {prRefLabel(link.ref)}
        </span>
        <span className="babysit-status" role="status">
          {babysitStatusText(state)}
        </span>
        <span className="pr-dock-spacer" />
        <button className="pr-detail-btn ghost sm" onClick={() => openPr(link.ref)}>
          <ExternalLink size={12} aria-hidden="true" />
          View PR
        </button>
        {paused ? (
          <button className="pr-detail-btn sm" onClick={() => resume(sessionId)}>
            <Play size={12} aria-hidden="true" />
            Resume
          </button>
        ) : (
          <button className="pr-detail-btn sm" onClick={() => pause(sessionId)} title="Stop sending updates on their own until you resume">
            <Pause size={12} aria-hidden="true" />
            Pause
          </button>
        )}
        <button
          className="pr-detail-btn ghost sm"
          onClick={() => void stop()}
          disabled={stopping}
          title={`Stop ${workflow.label} for this session. Updates will wait for you in the update dock.`}
        >
          <Square size={12} aria-hidden="true" />
          Stop
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
