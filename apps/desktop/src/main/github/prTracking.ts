import type { PrLinkSnapshot, PrRef, PrSummary } from "@cw-code/contracts";

export const PR_TRACKER_TICK_MS = 60_000;
export const PR_TRACKER_BATCH = 25;
export const PR_IDLE_AFTER_MS = 30 * 60_000;
export const PR_IDLE_INTERVAL_MS = 5 * 60_000;
export const PR_CLOSED_INTERVAL_MS = 15 * 60_000;

export interface TrackedPrEntry {
  ref: PrRef;
  snapshot?: PrLinkSnapshot;
  forced: boolean;
}

export function isPrDue(entry: TrackedPrEntry, now: number): boolean {
  const { snapshot } = entry;
  if (entry.forced || !snapshot) return true;
  const sinceSync = now - snapshot.syncedAt;
  if (snapshot.state === "MERGED") return false;
  if (snapshot.state === "CLOSED") return sinceSync >= PR_CLOSED_INTERVAL_MS;
  const idle = snapshot.updatedAt > 0 && now - snapshot.updatedAt > PR_IDLE_AFTER_MS;
  return !idle || sinceSync >= PR_IDLE_INTERVAL_MS;
}

export function snapshotOf(summary: PrSummary, syncedAt: number): PrLinkSnapshot {
  return { state: summary.state, headRefOid: summary.headRefOid, updatedAt: summary.updatedAt, syncedAt };
}

export function isValidSnapshot(value: unknown): value is PrLinkSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return (
    (snapshot.state === "OPEN" || snapshot.state === "CLOSED" || snapshot.state === "MERGED") &&
    typeof snapshot.headRefOid === "string" &&
    typeof snapshot.updatedAt === "number" &&
    Number.isFinite(snapshot.updatedAt) &&
    typeof snapshot.syncedAt === "number" &&
    Number.isFinite(snapshot.syncedAt)
  );
}

export function summaryChanged(previous: PrSummary | undefined, next: PrSummary): boolean {
  return (
    !previous ||
    previous.state !== next.state ||
    previous.headRefOid !== next.headRefOid ||
    previous.updatedAt !== next.updatedAt ||
    previous.ci !== next.ci ||
    previous.review !== next.review ||
    previous.mergeable !== next.mergeable ||
    previous.isDraft !== next.isDraft
  );
}
