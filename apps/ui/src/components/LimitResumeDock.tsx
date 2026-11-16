import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import { ipcErrorMessage } from "./ipcError.js";
import { useThreadEntry } from "./useThread.js";

export function limitResumeSentence(resetsAt: number, now: number = Date.now()): string {
  const date = new Date(resetsAt);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (resetsAt <= now) return "Usage limit reached. cw-code is about to continue this session.";
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const when = sameDay ? time : `${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
  return `Usage limit reached. cw-code continues this session when it resets, ${sameDay ? "at " : "on "}${when}.`;
}

export function LimitResumeDock({ sessionId }: { sessionId: string }) {
  const pending = useThreadEntry(sessionId, "limitResume");
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = pending != null;

  useEffect(() => {
    if (!waiting) setError(null);
  }, [waiting]);

  if (!pending) return null;

  const cancel = async () => {
    setCancelling(true);
    setError(null);
    try {
      await window.cw.cancelLimitResume(sessionId);
    } catch (err) {
      setError(`Could not cancel: ${ipcErrorMessage(err)}`);
    } finally {
      setCancelling(false);
    }
  };

  const sentence = limitResumeSentence(pending.resetsAt);
  return (
    <section className="pr-dock branch-dock" aria-label="Usage limit">
      <div className="pr-dock-head">
        <Hourglass size={14} className="pr-dock-head-icon warn" aria-hidden="true" />
        <span className="pr-dock-title branch-dock-title" title={sentence}>
          {sentence}
        </span>
        <span className="pr-dock-spacer" />
        <button className="pr-detail-btn ghost sm" onClick={() => void cancel()} disabled={cancelling}>
          Don't continue
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
