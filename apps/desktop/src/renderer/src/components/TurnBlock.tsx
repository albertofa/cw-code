import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  autoExpandIfFits,
  lead,
  activity,
  system,
  pinned
}: {
  running: boolean;
  startedAt?: number;
  durationMs?: number;
  hasActivity: boolean;
  autoExpandIfFits?: boolean;
  lead: ReactNode[];
  activity: ReactNode[];
  system: ReactNode[];
  pinned?: ReactNode;
}) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [measuring, setMeasuring] = useState(
    () => !running && Boolean(autoExpandIfFits) && hasActivity
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const prevRunning = useRef(running);

  useLayoutEffect(() => {
    if (prevRunning.current === running) return;
    prevRunning.current = running;
    if (running) {
      setManualOpen(null);
      return;
    }
    if (manualOpen === false) return;
    if (autoExpandIfFits) setMeasuring(true);
    else setManualOpen(null);
  }, [running, autoExpandIfFits, manualOpen]);

  useLayoutEffect(() => {
    if (!measuring) return;
    setMeasuring(false);
    const root = rootRef.current;
    const scroll = root?.closest(".thread-scroll");
    if (root && scroll && root.offsetHeight > 0 && root.offsetHeight <= scroll.clientHeight) {
      setManualOpen(true);
    } else {
      setManualOpen(null);
    }
  }, [measuring]);

  const open = manualOpen ?? (running || measuring);
  const elapsed = useElapsed(startedAt, running);
  const showHead = running || hasActivity || durationMs !== undefined;
  const label = running
    ? `Working for ${formatElapsed(elapsed)}`
    : durationMs !== undefined && durationMs > 0
      ? `Worked for ${formatDuration(durationMs)}`
      : "Worked";

  return (
    <div ref={rootRef} className={`turn-block${open ? " open" : ""}`}>
      {lead.length > 0 && <div className="turn-lead">{lead}</div>}
      {showHead && (
        <button
          type="button"
          className={`turn-head${running ? " turn-head-live" : ""}`}
          aria-expanded={open}
          disabled={!hasActivity}
          onClick={() => setManualOpen(!open)}
        >
          {running && <span className="pulse" aria-hidden="true" />}
          <span className="turn-head-label">{label}</span>
          <span className="turn-head-tail">
            {hasActivity && !running && (
              <span className="turn-head-hint">{open ? "Hide" : "Show work"}</span>
            )}
            {hasActivity && (
              <>
                <span className="turn-caret-right" aria-hidden="true"><ChevronRight size={16} /></span>
                <span className="turn-caret-down" aria-hidden="true"><ChevronDown size={16} /></span>
              </>
            )}
          </span>
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
