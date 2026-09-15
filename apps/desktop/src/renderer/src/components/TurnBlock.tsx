import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatDuration } from "./toolSummaries.js";
import { formatElapsed } from "./turnFormat.js";

function useElapsed(startedAt: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  if (startedAt === undefined) return 0;
  return Math.max(0, now - startedAt);
}

export function TurnBlock({
  running,
  startedAt,
  durationMs,
  hasActivity,
  lead,
  activity,
  system,
  pinned
}: {
  running: boolean;
  startedAt?: number;
  durationMs?: number;
  hasActivity: boolean;
  lead: ReactNode[];
  activity: ReactNode[];
  system: ReactNode[];
  pinned?: ReactNode;
}) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const prevRunning = useRef(running);
  useEffect(() => {
    if (prevRunning.current !== running) {
      prevRunning.current = running;
      setManualOpen(null);
    }
  }, [running]);
  const open = manualOpen ?? running;
  const elapsed = useElapsed(startedAt, running);
  const showHead = running || hasActivity || durationMs !== undefined;
  const label = running
    ? `Working for ${formatElapsed(elapsed)}`
    : durationMs !== undefined && durationMs > 0
      ? `Worked for ${formatDuration(durationMs)}`
      : "Worked";

  return (
    <div className={`turn-block${open ? " open" : ""}`}>
      {lead.length > 0 && <div className="turn-lead">{lead}</div>}
      {showHead && (
        <button
          type="button"
          className={`turn-head${running ? " turn-head-live" : ""}`}
          aria-expanded={open}
          onClick={() => setManualOpen(!open)}
        >
          <span className="turn-caret-right" aria-hidden="true"><ChevronRight size={14} /></span>
          <span className="turn-caret-down" aria-hidden="true"><ChevronDown size={14} /></span>
          {running && <span className="pulse" aria-hidden="true" />}
          <span className="turn-head-label">{label}</span>
        </button>
      )}
      {hasActivity && (
        <div className="turn-fold" hidden={!open}>
          {activity}
        </div>
      )}
      {system.length > 0 && <div className="turn-errors">{system}</div>}
      {pinned && <div className="turn-pinned">{pinned}</div>}
    </div>
  );
}
