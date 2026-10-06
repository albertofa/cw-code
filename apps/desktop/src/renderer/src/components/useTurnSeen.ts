import { useEffect } from "react";
import type { SessionStatus } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";

export function useMarkTurnSeen(sessionId: string | undefined, status: SessionStatus | undefined, visible: boolean): void {
  const setSessionStatus = useAppStore((s) => s.setSessionStatus);

  useEffect(() => {
    if (!sessionId || !visible || status !== "done") return;
    const mark = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", mark);
      void setSessionStatus(sessionId, "holding", "turn-seen").catch((err: unknown) =>
        console.warn(`setSessionStatus failed for ${sessionId} -> holding: ${(err as Error).message}`)
      );
    };
    if (!document.hidden) {
      mark();
      return;
    }
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [sessionId, status, visible, setSessionStatus]);
}
