import type { CreateSessionOptions, GitBranchInfo, GitStatus, SessionMeta, SessionPrLink } from "@cw-code/contracts";
import { prRefFromUrl } from "./prParsers.js";

export function linkFromStatus(session: SessionMeta, status: GitStatus, now: number): SessionPrLink | null {
  if (session.pr) return null;
  if (status.pullRequest?.state !== "OPEN") return null;
  const ref = prRefFromUrl(status.pullRequest.url);
  if (!ref) return null;
  return { ref, origin: "opened", lastSeenSha: "", lastSeenAt: now };
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
