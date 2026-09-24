import type { CreateSessionOptions, GitBranchInfo, GitStatus, PrRef, PrSummary, SessionMeta, SessionPrLink } from "@cw-code/contracts";
import { prKey, prRefFromUrl } from "./prParsers.js";

const MAX_UNLINKED_KEYS = 20;

export function canOwnAutoLink(session: SessionMeta): boolean {
  if (!session.worktreePath) return false;
  return session.status !== "resolved" && session.status !== "archived";
}

export function linkFromStatus(session: SessionMeta, status: GitStatus, now: number, headSha?: string | null): SessionPrLink | null {
  if (!canOwnAutoLink(session) || session.branch !== status.branch) return null;
  const pullRequest = status.pullRequest;
  if (pullRequest?.state !== "OPEN" || pullRequest.headRefName !== status.branch) return null;
  const ref = prRefFromUrl(pullRequest.url);
  if (!ref) return null;
  if (session.prUnlinked?.includes(prKey(ref))) return null;
  if (findLink(session.prs, ref)) return null;
  return { ref, origin: "opened", lastSeenSha: headSha ?? "", lastSeenAt: now };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isValidPrLink(value: unknown): value is SessionPrLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Partial<SessionPrLink>;
  const ref = link.ref as Partial<PrRef> | undefined;
  if (!ref || typeof ref !== "object") return false;
  if (!isNonEmptyString(ref.host) || !isNonEmptyString(ref.owner) || !isNonEmptyString(ref.repo)) return false;
  if (typeof ref.number !== "number" || !Number.isSafeInteger(ref.number) || ref.number <= 0) return false;
  if (link.origin !== "opened" && link.origin !== "workflow" && link.origin !== "linked") return false;
  if (link.workflowId !== undefined && typeof link.workflowId !== "string") return false;
  return typeof link.lastSeenSha === "string" && typeof link.lastSeenAt === "number" && Number.isFinite(link.lastSeenAt);
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

export function isFinishedPrState(state: PrSummary["state"] | null): boolean {
  return state === "MERGED" || state === "CLOSED";
}

export interface TurnSeenResult {
  ref: PrRef;
  covered: boolean;
  head: string | null;
  seenAt: number | null;
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
      next = upsertLink(next, markSeen(link, result.head, Math.max(now, result.seenAt ?? 0)));
    } else if (result.head !== null && result.head === worktreeHead && link.lastSeenSha !== result.head) {
      next = upsertLink(next, { ...link, lastSeenSha: result.head });
    }
  }
  return next;
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
