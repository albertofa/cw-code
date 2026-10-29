import { useEffect } from "react";
import type { SessionStatus } from "../cw.js";

export function useMarkTurnSeen(sessionId: string | undefined, status: SessionStatus | undefined, visible: boolean): void {
  useEffect(() => {
    if (!sessionId || !visible || status !== "done") return;
    const mark = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", mark);
      void window.cw.markTurnSeen(sessionId).catch((err: unknown) =>
        console.warn(`markTurnSeen failed for ${sessionId}: ${(err as Error).message}`)
      );
    };
    if (!document.hidden) {
      mark();
      return;
    }
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [sessionId, status, visible]);
}
