import type { PrCheck, PrDetail, PrReviewThread, PrSummary, PrTimelineItem, PrUpdate, SessionPrLink } from "@cw-code/contracts";

export function hasUnseen(pr: PrSummary, link: SessionPrLink): boolean {
  return (link.lastSeenSha !== "" && pr.headRefOid !== link.lastSeenSha) || pr.updatedAt > link.lastSeenAt;
}

export function updatesSince(detail: PrDetail, link: SessionPrLink): PrUpdate[] {
  const updates: PrUpdate[] = [];
  let ownActivity = false;
  for (const item of detail.timeline) {
    if (item.at <= link.lastSeenAt || isOwnPush(item, link)) continue;
    if (isViewerItem(detail, item)) {
      ownActivity = true;
      continue;
    }
    const update = toUpdate(item, detail);
    if (update) updates.push(update);
  }
  const checks = checksUpdate(detail, link.lastSeenAt);
  if (checks) updates.push(checks);
  const headMoved = link.lastSeenSha !== "" && detail.headRefOid !== link.lastSeenSha;
  if (headMoved && !updates.some((update) => update.kind === "commits")) {
    if (onlyViewerCommits(detail, link)) {
      ownActivity = true;
    } else {
      updates.push({ kind: "commits", at: detail.updatedAt, actor: null, summary: "New commits since the session last ran" });
    }
  }
  if (updates.length === 0 && !ownActivity && hasUnseen(detail, link)) {
    updates.push({ kind: "comment", at: detail.updatedAt, actor: null, summary: "PR updated" });
  }
  return updates.sort((a, b) => b.at - a.at);
}

export function seenThrough(pr: PrSummary | null | undefined, updates: PrUpdate[]): number | null {
  const times = updates.map((update) => update.at);
  if (pr) times.push(pr.updatedAt);
  return times.length > 0 ? Math.max(...times) : null;
}

function isViewer(detail: PrDetail, login: string): boolean {
  return detail.viewerLogin !== "" && login === detail.viewerLogin;
}

function isViewerItem(detail: PrDetail, item: PrTimelineItem): boolean {
  if (item.kind === "commits") return item.commits.every((commit) => isViewer(detail, commit.author));
  return isViewer(detail, item.actor);
}

function onlyViewerCommits(detail: PrDetail, link: SessionPrLink): boolean {
  const seenIndex = detail.commits.findIndex((commit) => commit.oid === link.lastSeenSha);
  const fresh =
    seenIndex >= 0 ? detail.commits.slice(seenIndex + 1) : detail.commits.filter((commit) => commit.committedAt > link.lastSeenAt);
  return fresh.length > 0 && fresh.every((commit) => isViewer(detail, commit.author));
}

function isOwnPush(item: PrTimelineItem, link: SessionPrLink): boolean {
  if (item.kind !== "commits" || link.lastSeenSha === "") return false;
  return item.commits[item.commits.length - 1]?.oid === link.lastSeenSha;
}

export function firstUnseenIndex(timeline: PrTimelineItem[], lastSeenAt: number): number {
  return timeline.findIndex((item) => item.at > lastSeenAt);
}

function toUpdate(item: PrTimelineItem, detail: PrDetail): PrUpdate | null {
  switch (item.kind) {
    case "commits":
      return { kind: "commits", at: item.at, actor: item.actor, summary: commitsSummary(item.actor, item.commits.length) };
    case "review":
      return { kind: "review", at: item.at, actor: item.actor, summary: reviewSummary(item, detail.threads) };
    case "comment":
      return { kind: "comment", at: item.at, actor: item.actor, summary: `${item.actor} commented` };
    case "review_requested":
      return { kind: "review_requested", at: item.at, actor: item.actor, summary: reviewRequestedSummary(item, detail) };
    default:
      return null;
  }
}

function commitsSummary(actor: string, count: number): string {
  return `${actor} pushed ${count} ${count === 1 ? "commit" : "commits"}`;
}

function reviewSummary(item: Extract<PrTimelineItem, { kind: "review" }>, threads: PrReviewThread[]): string {
  switch (item.state) {
    case "APPROVED":
      return `${item.actor} approved`;
    case "CHANGES_REQUESTED": {
      const unresolved = unresolvedThreadCount(item.threadIds, threads);
      const suffix = unresolved > 0 ? ` · ${unresolved} unresolved ${unresolved === 1 ? "thread" : "threads"}` : "";
      return `${item.actor} requested changes${suffix}`;
    }
    case "COMMENTED":
      return `${item.actor} commented`;
    case "DISMISSED":
      return `${item.actor} dismissed their review`;
  }
}

function unresolvedThreadCount(threadIds: string[], threads: PrReviewThread[]): number {
  const ids = new Set(threadIds);
  return threads.filter((thread) => ids.has(thread.id) && !thread.isResolved).length;
}

function reviewRequestedSummary(item: Extract<PrTimelineItem, { kind: "review_requested" }>, detail: PrDetail): string {
  const alreadyReviewed = detail.reviewers.some((reviewer) => reviewer.login === item.reviewer && reviewer.state !== "PENDING");
  const verb = alreadyReviewed ? "re-requested" : "requested";
  if (detail.reviewRequestedFromViewer) return `${item.actor} ${verb} your review`;
  return `${item.actor} ${verb} review from ${item.reviewer}`;
}

function checksUpdate(detail: PrDetail, lastSeenAt: number): PrUpdate | null {
  if (detail.ci === "failing") {
    const newlyFailing = detail.checkRuns.filter(
      (check) => check.status === "failure" && check.completedAt !== null && check.completedAt > lastSeenAt
    );
    if (newlyFailing.length === 0) return null;
    const at = Math.max(...newlyFailing.map((check) => check.completedAt as number));
    return { kind: "checks_failed", at, actor: null, summary: failedChecksSummary(newlyFailing) };
  }
  if (detail.ci === "passing") {
    const recentlyCompleted = detail.checkRuns.filter((check) => check.completedAt !== null && check.completedAt > lastSeenAt);
    if (recentlyCompleted.length === 0) return null;
    const at = Math.max(...recentlyCompleted.map((check) => check.completedAt as number));
    return { kind: "checks_passed", at, actor: null, summary: `Checks passed (${detail.checks.passed}/${detail.checks.total})` };
  }
  return null;
}

function failedChecksSummary(failing: PrCheck[]): string {
  if (failing.length === 1) {
    const [check] = failing;
    return check.workflow ? `${check.workflow} / ${check.name} failed` : `${check.name} failed`;
  }
  return `${failing.length} checks failed: ${failing.map((check) => check.name).join(", ")}`;
}
