import type { UsageTotals } from "@cw-code/contracts";
import type { ThreadExtras, ThreadService } from "../threads/ThreadService.js";
import type { UsageTopic } from "./UsageTopic.js";

interface SessionUsageExtras {
  usageTotals: UsageTotals | null;
  usageTotalsError: string | null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function wireSessionUsageTotals(
  threads: Pick<ThreadService, "registerExtras" | "refreshExtras">,
  usageTopic: Pick<UsageTopic, "sessionTotals">,
  onUsageRecorded: (cb: (sessionId: string) => void) => unknown
): void {
  const cache = new Map<string, SessionUsageExtras>();

  const compute = (sessionId: string): SessionUsageExtras => {
    try {
      const extras = { usageTotals: usageTopic.sessionTotals(sessionId), usageTotalsError: null };
      cache.set(sessionId, extras);
      return extras;
    } catch (error) {
      console.warn(`[usage] totals for session ${sessionId} failed: ${describeError(error)}`);
      return { usageTotals: null, usageTotalsError: describeError(error) };
    }
  };

  const extras = (sessionId: string): ThreadExtras => cache.get(sessionId) ?? compute(sessionId);

  threads.registerExtras(extras);
  onUsageRecorded((sessionId) => {
    cache.delete(sessionId);
    threads.refreshExtras(sessionId);
  });
}
