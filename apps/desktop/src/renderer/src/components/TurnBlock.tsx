import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { describeWaitingTools, formatDuration, type PendingTool } from "./toolSummaries.js";
import { useElapsed } from "./useElapsed.js";
import { useThreadVisible } from "./threadVisibility.js";

export function TurnBlock({
  running,
  startedAt,
  durationMs,
  hasActivity,
  autoExpandIfFits,
  pending,
  lead,
  activity,
  system,
  pinned,
  footer
}: {
  running: boolean;
  startedAt?: number;
  durationMs?: number;
  hasActivity: boolean;
  autoExpandIfFits?: boolean;
  pending?: PendingTool[];
  lead: ReactNode[];
  activity: ReactNode[];
  system: ReactNode[];
  pinned: ReactNode[];
  footer?: ReactNode;
}) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [measuring, setMeasuring] = useState(
    () => !running && Boolean(autoExpandIfFits) && hasActivity
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const prevRunning = useRef(running);
  const visible = useThreadVisible();
  const foldId = useId();

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
    if (!measuring || !visible) return;
    setMeasuring(false);
    const root = rootRef.current;
    const scroll = root?.closest(".thread-scroll");
    if (root && scroll && root.offsetHeight > 0 && root.offsetHeight <= scroll.clientHeight) {
      setManualOpen(true);
    } else {
      setManualOpen(null);
    }
  }, [measuring, visible]);

  const open = manualOpen ?? (running || measuring);
  const elapsed = useElapsed(startedAt, running);
  const waiting = running ? describeWaitingTools(pending ?? [], Date.now(), startedAt) : undefined;
  const showHead = running || hasActivity || durationMs !== undefined;
  const label = running
    ? `Working for ${formatDuration(elapsed)}`
    : durationMs !== undefined && durationMs > 0
      ? `Worked for ${formatDuration(durationMs)}`
      : "Worked";

  return (
    <div ref={rootRef} className={`turn-block${open ? " open" : ""}`}>
      {lead.length > 0 && <div className="turn-lead">{lead}</div>}
      {showHead && (
        <div className={`turn-head-row${running ? " turn-head-sticky" : ""}`}>
          <button
            type="button"
            className={`turn-head${running ? " turn-head-live" : ""}`}
            aria-expanded={hasActivity ? open : undefined}
            aria-controls={hasActivity ? foldId : undefined}
            disabled={!hasActivity}
            onClick={() => setManualOpen(!open)}
          >
            {hasActivity && (
              <span className={`turn-caret collapse-caret${open ? " open" : ""}`} aria-hidden="true">
                <ChevronRight size={14} />
              </span>
            )}
            <span className="turn-head-label">{label}</span>
            {waiting && <span className="turn-head-detail">· {waiting}</span>}
            <span className="turn-head-rule" aria-hidden="true" />
          </button>
        </div>
      )}
      {hasActivity && (
        <div id={foldId} className="turn-fold" hidden={!open}>
          {activity}
        </div>
      )}
      {system.length > 0 && <div className="turn-errors">{system}</div>}
      {pinned.length > 0 && <div className="turn-pinned">{pinned}</div>}
      {footer}
    </div>
  );
}
