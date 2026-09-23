import type { PrBucket, PrRef, PrSummary, Session } from "../cw.js";
import { prBucket, prKey } from "./prInbox.js";
import { hasUnseen } from "./prUpdates.js";

export type PrInboxFilterId = "all" | "review" | "action" | "updated" | "with-session" | "not-cloned";

export interface PrInboxFilterDef {
  id: PrInboxFilterId;
  label: string;
}

export const PR_INBOX_FILTERS: PrInboxFilterDef[] = [
  { id: "all", label: "All" },
  { id: "review", label: "To review" },
  { id: "action", label: "Needs action" },
  { id: "updated", label: "Updated" },
  { id: "with-session", label: "With session" },
  { id: "not-cloned", label: "Not cloned" }
];

export interface PrInboxRow {
  pr: PrSummary;
  bucket: PrBucket;
  linkedSessions: Session[];
  hasUnseenSession: boolean;
  cloned: boolean;
}

export function buildInboxRows(items: PrSummary[], sessions: Session[], isCloned: (ref: PrRef) => boolean): PrInboxRow[] {
  return items.map((pr) => {
    const key = prKey(pr.ref);
    const linkedSessions = sessions.filter((session) => session.pr !== undefined && prKey(session.pr.ref) === key);
    const hasUnseenSession = linkedSessions.some((session) => session.pr !== undefined && hasUnseen(pr, session.pr));
    return { pr, bucket: prBucket(pr), linkedSessions, hasUnseenSession, cloned: isCloned(pr.ref) };
  });
}

export function matchesFilter(row: PrInboxRow, filter: PrInboxFilterId): boolean {
  switch (filter) {
    case "all":
      return true;
    case "review":
      return row.bucket === "review";
    case "action":
      return row.bucket === "action";
    case "updated":
      return row.hasUnseenSession;
    case "with-session":
      return row.linkedSessions.length > 0;
    case "not-cloned":
      return !row.cloned;
  }
}

export function filterCounts(rows: PrInboxRow[]): Record<PrInboxFilterId, number> {
  const counts = Object.fromEntries(PR_INBOX_FILTERS.map((filter) => [filter.id, 0])) as Record<PrInboxFilterId, number>;
  for (const row of rows) {
    for (const filter of PR_INBOX_FILTERS) {
      if (matchesFilter(row, filter.id)) counts[filter.id] += 1;
    }
  }
  return counts;
}

export const BUCKET_ORDER: PrBucket[] = ["review", "action", "ready", "waiting", "merged"];

export const BUCKET_TITLE: Record<PrBucket, string> = {
  review: "Needs your review",
  action: "Your PRs · needs action",
  ready: "Ready to merge",
  waiting: "Waiting",
  merged: "Recently merged"
};

export const BUCKET_HINT: Record<PrBucket, string> = {
  review: "review-requested:@me",
  action: "failing checks · changes requested · conflicts",
  ready: "approved + green · merge on GitHub",
  waiting: "draft or awaiting reviewers · includes others' PRs you're only involved in",
  merged: "last 7 days"
};

export const DEFAULT_COLLAPSED_BUCKETS: PrBucket[] = ["merged"];

export interface PrInboxGroup {
  bucket: PrBucket;
  rows: PrInboxRow[];
}

export function groupRowsByBucket(rows: PrInboxRow[]): PrInboxGroup[] {
  return BUCKET_ORDER.map((bucket) => ({ bucket, rows: rows.filter((row) => row.bucket === bucket) })).filter(
    (group) => group.rows.length > 0
  );
}

function mainLinkedSession(sessions: Session[]): Session | null {
  if (sessions.length === 0) return null;
  const opened = sessions.find((session) => session.pr?.origin === "opened");
  if (opened) return opened;
  const review = sessions.find((session) => session.pr?.workflowId === "review");
  if (review) return review;
  return sessions.reduce((latest, session) => (session.updatedAt > latest.updatedAt ? session : latest));
}

export function rowDeltaText(row: PrInboxRow, nowMs: number): string | null {
  if (!row.hasUnseenSession) return null;
  const session = mainLinkedSession(row.linkedSessions);
  if (!session?.pr) return null;
  if (row.pr.headRefOid !== session.pr.lastSeenSha) return "new commits";
  return `updated ${formatRelativeAge(row.pr.updatedAt, nowMs)}`;
}

export function formatRelativeAge(fromMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}
