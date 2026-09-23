import type { CreateSessionOptions, GitBranchInfo, GitStatus, SessionMeta, SessionPrLink } from "@cw-code/contracts";
import { prKey, prRefFromUrl } from "./prParsers.js";

const MAX_UNLINKED_KEYS = 20;

export function canOwnAutoLink(session: SessionMeta): boolean {
  if (!session.worktreePath) return false;
  return session.status !== "resolved" && session.status !== "archived";
}

export function linkFromStatus(session: SessionMeta, status: GitStatus, now: number, headSha?: string | null): SessionPrLink | null {
  if (session.pr) return null;
  if (!canOwnAutoLink(session) || session.branch !== status.branch) return null;
  const pullRequest = status.pullRequest;
  if (pullRequest?.state !== "OPEN" || pullRequest.headRefName !== status.branch) return null;
  const ref = prRefFromUrl(pullRequest.url);
  if (!ref) return null;
  if (session.prUnlinked?.includes(prKey(ref))) return null;
  return { ref, origin: "opened", lastSeenSha: headSha ?? "", lastSeenAt: now };
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
  return { ...link, lastSeenSha: headSha ?? link.lastSeenSha, lastSeenAt: now };
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
