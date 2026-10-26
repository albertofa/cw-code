import type { SessionMeta, SessionStatus } from "@cw-code/contracts";
import { isWorkingSetStatus, WORKING_SET_STATUSES } from "@cw-code/shared/workingSet";

const WORKING_SET_RANK: Partial<Record<SessionStatus, number>> = {
  "input-required": 0,
  working: 1,
  done: 2,
  babysit: 3,
  holding: 4
};

export { isWorkingSetStatus, WORKING_SET_STATUSES };

export function compareWorkingSet(a: SessionMeta, b: SessionMeta): number {
  const rankA = WORKING_SET_RANK[a.status] ?? Number.POSITIVE_INFINITY;
  const rankB = WORKING_SET_RANK[b.status] ?? Number.POSITIVE_INFINITY;
  if (rankA !== rankB) return rankA - rankB;
  return b.updatedAt - a.updatedAt;
}

export function expiredHoldingIds(sessions: SessionMeta[], holdingHours: number, now: number): string[] {
  if (holdingHours <= 0) return [];
  const thresholdMs = holdingHours * 3_600_000;
  return sessions
    .filter((s) => s.status === "holding" && now - s.updatedAt >= thresholdMs)
    .map((s) => s.id);
}
