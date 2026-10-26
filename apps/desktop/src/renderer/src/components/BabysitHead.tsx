import { useState } from "react";
import { Activity, Circle, CircleCheck, CircleX, ExternalLink, Pause, Play, Square } from "lucide-react";
import type { BabysitPhase, BabysitState, PrDetail } from "@cw-code/contracts";
import { usePrStore } from "../stores/prStore.js";
import { babysitStatusText } from "./babysitLabels.js";
import { mergeBoxState, type MergeRow } from "./prDetailModel.js";
import { prKey } from "./prInbox.js";
import { usePrDetail } from "./usePrs.js";
import { prRefLabel } from "./sessionPrLinks.js";
import { ipcErrorMessage } from "./ipcError.js";

function MergeRowIcon({ row, neutral }: { row: MergeRow; neutral: boolean }) {
  if (neutral) return <Circle size={13} className="pr-dock-update-icon tone-neutral" aria-hidden="true" />;
  return row.ok ? (
    <CircleCheck size={13} className="pr-dock-update-icon tone-ok" aria-hidden="true" />
  ) : (
    <CircleX size={13} className="pr-dock-update-icon tone-bad" aria-hidden="true" />
  );
}

function MergeState({ pr }: { pr: PrDetail }) {
  const box = mergeBoxState(pr);
  const rows = [box.ci, box.conflicts, box.review];
  return (
    <ul className="pr-dock-list" aria-label="Merge state">
      {rows.map((row) => (
        <li key={row.label} className="pr-dock-item">
          <MergeRowIcon row={row} neutral={row === box.review && pr.review === "none"} />
          <span className="pr-dock-item-text">
            {row.label}
            {row.detail ? ` · ${row.detail}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function StatusMark({ phase }: { phase: BabysitPhase["kind"] }) {
  if (phase === "paused") return <Pause size={11} aria-hidden="true" />;
  if (phase === "done") return <CircleCheck size={12} aria-hidden="true" />;
  return <span className="babysit-mark" aria-hidden="true" />;
}

export function BabysitHead({ sessionId, state }: { sessionId: string; state: BabysitState }) {
  const openPr = usePrStore((s) => s.openPr);
  const detail = usePrDetail(prKey(state.link.ref))?.detail ?? null;
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { link, workflow, phase } = state;
  const paused = phase.kind === "paused";

  const pause = async () => {
    setError(null);
    try {
      await window.cw.pauseAutoFollowUp(sessionId);
    } catch (err) {
      setError(`Could not pause ${workflow.label}: ${ipcErrorMessage(err)}`);
    }
  };

  const resume = () => window.cw.resumeAutoFollowUp(sessionId);

  const resumeClicked = async () => {
    setError(null);
    try {
      await resume();
    } catch (err) {
      setError(`Could not resume ${workflow.label}: ${ipcErrorMessage(err)}`);
    }
  };

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setError(null);
    const { workflowId: _workflowId, ...rest } = link;
    try {
      await window.cw.linkSessionPr(sessionId, rest);
    } catch (err) {
      setError(`Could not stop ${workflow.label}: ${ipcErrorMessage(err)}`);
      setStopping(false);
      return;
    }
    try {
      await resume();
    } catch (err) {
      setError(`Stopped ${workflow.label}, but could not clear its pause: ${ipcErrorMessage(err)}`);
    } finally {
      setStopping(false);
    }
  };

  return (
    <>
      <div className="pr-dock-head babysit-head">
        <span className="babysit-tag">
          <Activity size={12} aria-hidden="true" />
          {workflow.label}
        </span>
        <span className="pr-dock-title">{prRefLabel(link.ref)}</span>
        <span className={`babysit-status ${phase.kind}`} role="status">
          <StatusMark phase={phase.kind} />
          <span className="babysit-status-text">{babysitStatusText(state)}</span>
        </span>
        <span className="pr-dock-spacer" />
        <button className="pr-detail-btn ghost sm" onClick={() => openPr(link.ref)}>
          <ExternalLink size={12} aria-hidden="true" />
          View PR
        </button>
        {paused ? (
          <button className="pr-detail-btn sm" onClick={() => void resumeClicked()}>
            <Play size={12} aria-hidden="true" />
            Resume
          </button>
        ) : (
          <button className="pr-detail-btn sm" onClick={() => void pause()} title="Stop sending updates on their own until you resume">
            <Pause size={12} aria-hidden="true" />
            Pause
          </button>
        )}
        <button
          className="pr-detail-btn ghost sm"
          onClick={() => void stop()}
          disabled={stopping}
          title={`Stop ${workflow.label} for this session. Updates will wait for you here.`}
        >
          <Square size={12} aria-hidden="true" />
          Stop
        </button>
      </div>
      {phase.kind === "done" && detail && <MergeState pr={detail} />}
      {error && (
        <div className="pr-dock-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
