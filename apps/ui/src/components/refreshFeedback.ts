import { useCallback, useEffect, useRef, useState } from "react";

export const MIN_BUSY_MS = 450;
export const DONE_MS = 1600;

export type RefreshPhase = "idle" | "busy" | "done" | "failed";

/**
 * Wraps a refresh action so the user always sees it happen: the busy state lasts
 * long enough to be perceived even when the call returns instantly, and it is
 * followed by a short confirmation.
 */
export function useRefreshFeedback(
  run: () => Promise<unknown>,
  { minBusyMs = MIN_BUSY_MS, doneMs = DONE_MS }: { minBusyMs?: number; doneMs?: number } = {}
): { phase: RefreshPhase; busy: boolean; trigger: () => void } {
  const [phase, setPhase] = useState<RefreshPhase>("idle");
  const alive = useRef(true);
  const timer = useRef<number | null>(null);
  const running = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const trigger = useCallback(() => {
    if (running.current) return;
    running.current = true;
    if (timer.current !== null) window.clearTimeout(timer.current);
    setPhase("busy");
    const startedAt = Date.now();
    void (async () => {
      let ok = true;
      try {
        await run();
      } catch {
        ok = false;
      }
      const wait = Math.max(0, minBusyMs - (Date.now() - startedAt));
      timer.current = window.setTimeout(() => {
        running.current = false;
        if (!alive.current) return;
        setPhase(ok ? "done" : "failed");
        timer.current = window.setTimeout(() => {
          if (alive.current) setPhase("idle");
        }, doneMs);
      }, wait);
    })();
  }, [run, minBusyMs, doneMs]);

  return { phase, busy: phase === "busy", trigger };
}
