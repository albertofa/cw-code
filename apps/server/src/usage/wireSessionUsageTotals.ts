import type { ThreadService } from "../threads/ThreadService.js";
import type { UsageTopic } from "./UsageTopic.js";

export function wireSessionUsageTotals(
  threads: Pick<ThreadService, "registerExtras" | "refreshExtras">,
  usageTopic: Pick<UsageTopic, "sessionTotals">,
  onUsageRecorded: (cb: (sessionId: string) => void) => unknown
): void {
  threads.registerExtras((sessionId) => ({ usageTotals: usageTopic.sessionTotals(sessionId) }));
  onUsageRecorded((sessionId) => threads.refreshExtras(sessionId));
}
