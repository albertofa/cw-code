import type { Session, SessionStatus } from "../cw.js";

const WORKING_SET_RANK: Partial<Record<SessionStatus, number>> = {
  "input-required": 0,
  working: 1,
  done: 2,
  holding: 3
};

export function isWorkingSetStatus(status: SessionStatus): boolean {
  return WORKING_SET_RANK[status] !== undefined;
}

export function compareWorkingSet(a: Session, b: Session): number {
  const rankA = WORKING_SET_RANK[a.status] ?? Number.POSITIVE_INFINITY;
  const rankB = WORKING_SET_RANK[b.status] ?? Number.POSITIVE_INFINITY;
  if (rankA !== rankB) return rankA - rankB;
  return b.updatedAt - a.updatedAt;
}

export function expiredHoldingIds(sessions: Session[], holdingHours: number, now: number): string[] {
  if (holdingHours <= 0) return [];
  const thresholdMs = holdingHours * 3_600_000;
  return sessions
    .filter((s) => s.status === "holding" && now - s.updatedAt >= thresholdMs)
    .map((s) => s.id);
}
