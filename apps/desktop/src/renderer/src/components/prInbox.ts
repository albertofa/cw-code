import { prKey } from "@cw-code/shared/prRef";
import type { PrBucket, PrSummary } from "../cw.js";

export { prKey };

export function prBucket(pr: PrSummary): PrBucket {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (!pr.viewerIsAuthor && pr.reviewRequestedFromViewer) return "review";
  if (pr.viewerIsAuthor && (pr.ci === "failing" || pr.review === "changes_requested" || pr.mergeable === "CONFLICTING")) return "action";
  if (pr.viewerIsAuthor && pr.review === "approved" && pr.ci === "passing") return "ready";
  return "waiting";
}

export function needsAttentionCount(items: PrSummary[]): number {
  return items.filter((pr) => {
    const bucket = prBucket(pr);
    return bucket === "review" || bucket === "action";
  }).length;
}
