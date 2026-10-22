import type {
  CreateSessionOptions,
  GitBranchInfo,
  GitPullRequest,
  GitStatus,
  IssueRef,
  PrLinkSnapshot,
  PrRef,
  PrSummary,
  RepoRef,
  RunRef,
  SessionIssueLink,
  SessionMeta,
  SessionPrLink,
  SessionRunLink
} from "@cw-code/contracts";
import { prKey, prRefFromUrl } from "./prParsers.js";
import { isValidSnapshot } from "./prTracking.js";

const MAX_UNLINKED_KEYS = 20;

export function canOwnAutoLink(session: SessionMeta): boolean {
  if (!session.worktreePath && !session.branch) return false;
  return session.status !== "resolved" && session.status !== "archived";
}

function belongsToCheckout(pullRequest: GitPullRequest, headSha: string | null | undefined): boolean {
  if (pullRequest.state === "OPEN") return true;
  return pullRequest.headRefOid !== "" && !!headSha && pullRequest.headRefOid === headSha;
}

export function linkFromStatus(session: SessionMeta, status: GitStatus, now: number, headSha?: string | null): SessionPrLink | null {
  if (!canOwnAutoLink(session) || session.branch !== status.branch) return null;
  const pullRequest = status.pullRequest;
  if (!pullRequest || pullRequest.headRefName !== status.branch) return null;
  if (!belongsToCheckout(pullRequest, status.headSha)) return null;
  const ref = prRefFromUrl(pullRequest.url);
  if (!ref) return null;
  if (session.prUnlinked?.includes(prKey(ref))) return null;
  if (findLink(session.prs, ref)) return null;
  return {
    ref,
    origin: "opened",
    lastSeenSha: pullRequest.headRefOid || headSha || "",
    lastSeenAt: now,
    snapshot: { state: pullRequest.state, headRefOid: pullRequest.headRefOid, updatedAt: pullRequest.updatedAt, syncedAt: now }
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasRepoRef(ref: Partial<RepoRef> | undefined): boolean {
  if (!ref || typeof ref !== "object") return false;
  return isNonEmptyString(ref.host) && isNonEmptyString(ref.owner) && isNonEmptyString(ref.repo);
}

function hasLinkEnvelope(link: { origin?: unknown; workflowId?: unknown; lastSeenAt?: unknown }): boolean {
  if (link.origin !== "opened" && link.origin !== "workflow" && link.origin !== "linked") return false;
  if (link.workflowId !== undefined && typeof link.workflowId !== "string") return false;
  return typeof link.lastSeenAt === "number" && Number.isFinite(link.lastSeenAt);
}

export function isValidPrLink(value: unknown): value is SessionPrLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Partial<SessionPrLink>;
  const ref = link.ref as Partial<PrRef> | undefined;
  if (!hasRepoRef(ref) || !isPositiveInteger(ref?.number)) return false;
  return hasLinkEnvelope(link) && typeof link.lastSeenSha === "string";
}

function repoKey(ref: RepoRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}`.toLowerCase();
}

export function issueKey(ref: IssueRef): string {
  return `${repoKey(ref)}#${ref.number}`;
}

export function runKey(ref: RunRef): string {
  return `${repoKey(ref)}/runs/${ref.runId}`;
}

export function isValidIssueLink(value: unknown): value is SessionIssueLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Partial<SessionIssueLink>;
  const ref = link.ref as Partial<IssueRef> | undefined;
  return hasRepoRef(ref) && isPositiveInteger(ref?.number) && hasLinkEnvelope(link);
}

export function isValidRunLink(value: unknown): value is SessionRunLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Partial<SessionRunLink>;
  const ref = link.ref as Partial<RunRef> | undefined;
  return hasRepoRef(ref) && isPositiveInteger(ref?.runId) && hasLinkEnvelope(link);
}

function findByKey<T extends { ref: R }, R>(links: T[] | undefined, ref: R, keyOf: (ref: R) => string): T | undefined {
  const key = keyOf(ref);
  return links?.find((link) => keyOf(link.ref) === key);
}

function upsertByKey<T extends { ref: R }, R>(links: T[] | undefined, link: T, keyOf: (ref: R) => string): T[] {
  const key = keyOf(link.ref);
  const current = links ?? [];
  const index = current.findIndex((existing) => keyOf(existing.ref) === key);
  if (index < 0) return [...current, link];
  return current.map((existing, i) => (i === index ? link : existing));
}

function removeByKey<T extends { ref: R }, R>(links: T[] | undefined, ref: R, keyOf: (ref: R) => string): T[] {
  const key = keyOf(ref);
  return (links ?? []).filter((link) => keyOf(link.ref) !== key);
}

export function findIssueLink(issues: SessionIssueLink[] | undefined, ref: IssueRef): SessionIssueLink | undefined {
  return findByKey(issues, ref, issueKey);
}

export function upsertIssueLink(issues: SessionIssueLink[] | undefined, link: SessionIssueLink): SessionIssueLink[] {
  return upsertByKey(issues, link, issueKey);
}

export function removeIssueLink(issues: SessionIssueLink[] | undefined, ref: IssueRef): SessionIssueLink[] {
  return removeByKey(issues, ref, issueKey);
}

export function findRunLink(runs: SessionRunLink[] | undefined, ref: RunRef): SessionRunLink | undefined {
  return findByKey(runs, ref, runKey);
}

export function upsertRunLink(runs: SessionRunLink[] | undefined, link: SessionRunLink): SessionRunLink[] {
  return upsertByKey(runs, link, runKey);
}

export function removeRunLink(runs: SessionRunLink[] | undefined, ref: RunRef): SessionRunLink[] {
  return removeByKey(runs, ref, runKey);
}

export function markLinkSeenAt<T extends SessionIssueLink | SessionRunLink>(link: T, seenAt: number): T {
  return { ...link, lastSeenAt: Math.max(link.lastSeenAt, seenAt) };
}

export function findLink(prs: SessionPrLink[] | undefined, ref: PrRef): SessionPrLink | undefined {
  const key = prKey(ref);
  return prs?.find((link) => prKey(link.ref) === key);
}

export function upsertLink(prs: SessionPrLink[] | undefined, link: SessionPrLink): SessionPrLink[] {
  const key = prKey(link.ref);
  const current = prs ?? [];
  const index = current.findIndex((existing) => prKey(existing.ref) === key);
  if (index < 0) return [...current, link];
  return current.map((existing, i) => (i === index ? link : existing));
}

export function removeLink(prs: SessionPrLink[] | undefined, ref: PrRef): SessionPrLink[] {
  const key = prKey(ref);
  return (prs ?? []).filter((link) => prKey(link.ref) !== key);
}

export function addUnlinkedKey(existing: string[] | undefined, key: string): string[] {
  const next = (existing ?? []).filter((k) => k !== key);
  next.push(key);
  return next.length > MAX_UNLINKED_KEYS ? next.slice(next.length - MAX_UNLINKED_KEYS) : next;
}

export function removeUnlinkedKey(existing: string[] | undefined, key: string): string[] | undefined {
  if (!existing) return existing;
  const next = existing.filter((k) => k !== key);
  return next.length > 0 ? next : undefined;
}

export function markSeen(link: SessionPrLink, headSha: string | null, now: number): SessionPrLink {
  return { ...link, lastSeenSha: headSha ?? link.lastSeenSha, lastSeenAt: Math.max(link.lastSeenAt, now) };
}

function sameSnapshot(current: PrLinkSnapshot | undefined, next: PrLinkSnapshot): boolean {
  return !!current && current.state === next.state && current.headRefOid === next.headRefOid && current.updatedAt === next.updatedAt;
}

export function applyLinkSnapshots(
  prs: SessionPrLink[] | undefined,
  snapshots: ReadonlyMap<string, PrLinkSnapshot>
): SessionPrLink[] | null {
  if (!prs?.length) return null;
  let changed = false;
  const next = prs.map((link) => {
    const snapshot = snapshots.get(prKey(link.ref));
    if (!snapshot || sameSnapshot(link.snapshot, snapshot)) return link;
    changed = true;
    return { ...link, snapshot };
  });
  return changed ? next : null;
}

function newerSnapshot(current: PrLinkSnapshot | undefined, candidate: unknown): PrLinkSnapshot | undefined {
  if (!isValidSnapshot(candidate)) return current;
  return !current || candidate.syncedAt > current.syncedAt ? candidate : current;
}

export function latestLinkSnapshot(sessions: SessionMeta[], ref: PrRef): PrLinkSnapshot | undefined {
  let latest: PrLinkSnapshot | undefined;
  for (const session of sessions) {
    const link = findLink(session.prs, ref);
    if (link) latest = newerSnapshot(latest, link.snapshot);
  }
  return latest;
}

export function collectTrackedPrRefs(sessions: SessionMeta[]): Array<{ ref: PrRef; snapshot?: PrLinkSnapshot }> {
  const byKey = new Map<string, { ref: PrRef; snapshot?: PrLinkSnapshot }>();
  for (const session of sessions) {
    if (session.status === "resolved" || session.status === "archived") continue;
    for (const link of session.prs ?? []) {
      const key = prKey(link.ref);
      const existing = byKey.get(key);
      const snapshot = newerSnapshot(existing?.snapshot, link.snapshot);
      byKey.set(key, { ref: existing?.ref ?? link.ref, ...(snapshot ? { snapshot } : {}) });
    }
  }
  return [...byKey.values()];
}

export function isFinishedPrState(state: PrSummary["state"] | null): boolean {
  return state === "MERGED" || state === "CLOSED";
}

export interface TurnSeenResult {
  ref: PrRef;
  covered: boolean;
  head: string | null;
  seenAt: number | null;
  /** Caps the seen time at the turn start so activity during the turn still counts as new. */
  seenUntil?: number;
}

export function applyTurnSeen(
  prs: SessionPrLink[],
  results: TurnSeenResult[],
  worktreeHead: string | null,
  now: number
): SessionPrLink[] {
  let next = prs;
  for (const result of results) {
    const link = findLink(next, result.ref);
    if (!link) continue;
    if (result.covered) {
      next = upsertLink(next, markSeen(link, result.head, result.seenUntil ?? Math.max(now, result.seenAt ?? 0)));
    } else if (result.head !== null && result.head === worktreeHead && link.lastSeenSha !== result.head) {
      next = upsertLink(next, { ...link, lastSeenSha: result.head });
    }
  }
  return next;
}

export function applyFinalReview(prs: SessionPrLink[], review: { ref: PrRef; sha: string }, head: string | null): SessionPrLink[] {
  const link = findLink(prs, review.ref);
  if (!link || head !== review.sha || link.finalReviewSha === head) return prs;
  return upsertLink(prs, { ...link, finalReviewSha: head });
}

export function onlyFinishedLinks(prs: SessionPrLink[] | undefined, finishedKeys: ReadonlySet<string>): boolean {
  if (!prs?.length) return false;
  return prs.every((link) => finishedKeys.has(prKey(link.ref)));
}

export type PrHeadPlan =
  | { kind: "attach"; branch: string }
  | { kind: "base"; branch: string }
  | { kind: "fetch"; number: number };

export function authorLocalBranch(options: CreateSessionOptions, localBranches: GitBranchInfo[]): GitBranchInfo | null {
  const head = options.prHead;
  if (!head?.viewerIsAuthor) return null;
  return localBranches.find((branch) => !branch.remote && branch.name === head.headRefName) ?? null;
}

export function prHeadPlan(
  options: CreateSessionOptions,
  localBranches: GitBranchInfo[],
  localTips: Record<string, string>
): PrHeadPlan | null {
  const head = options.prHead;
  if (!head) return null;
  const local = authorLocalBranch(options, localBranches);
  if (local && head.headRefOid && localTips[local.name] === head.headRefOid) {
    return local.worktreePath ? { kind: "base", branch: local.name } : { kind: "attach", branch: local.name };
  }
  return { kind: "fetch", number: head.number };
}
