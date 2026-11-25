import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import { ipcErrorMessage } from "./ipcError.js";
import { useThreadEntry } from "./useThread.js";

/** `resumesAt` is when cw-code starts the continuation, shortly after the limit resets. */
export function limitResumeSentence(resumesAt: number, now: number = Date.now()): string {
  if (resumesAt <= now) return "Usage limit reached. cw-code is about to continue this session.";
  const date = new Date(resumesAt);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const when = sameDay ? time : `${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
  return `Usage limit reached. cw-code continues this session ${sameDay ? "at " : "on "}${when}, once it resets.`;
}

/** Re-renders once `at` passes, so the dock switches to "about to continue" without waiting for another update. */
function useNowAfter(at: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === undefined) return;
    const wait = at - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [at]);
  return now;
}

export function LimitResumeDock({ sessionId }: { sessionId: string }) {
  const pending = useThreadEntry(sessionId, "limitResume");
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = pending != null;
  const now = useNowAfter(pending?.resumesAt);

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

  const sentence = limitResumeSentence(pending.resumesAt, now);
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
