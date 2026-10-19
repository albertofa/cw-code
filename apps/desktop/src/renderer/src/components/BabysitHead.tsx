import { useState } from "react";
import { Activity, Circle, CircleCheck, CircleX, ExternalLink, Pause, Play, Square } from "lucide-react";
import type { PrDetail } from "@cw-code/contracts";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { mergeBoxState, type MergeRow } from "./prDetailModel.js";
import { prKey } from "./prInbox.js";
import { babysitStatusText, type BabysitState } from "./prSessionModel.js";
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

export function BabysitHead({ sessionId, state }: { sessionId: string; state: BabysitState }) {
  const pause = useAppStore((s) => s.pauseAutoFollowUp);
  const resume = useAppStore((s) => s.resumeAutoFollowUp);
  const applySession = useAppStore((s) => s.applySession);
  const openPr = usePrStore((s) => s.openPr);
  const detail = usePrStore((s) => s.detailByKey[prKey(state.link.ref)]);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <>
      <div className="pr-dock-head babysit-head">
        <span className="babysit-tag">
          <Activity size={12} aria-hidden="true" />
          {workflow.label}
        </span>
        <span className="pr-dock-title">{prRefLabel(link.ref)}</span>
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
