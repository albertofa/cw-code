import type { BranchMismatch, GitStatus } from "@cw-code/contracts";

interface BranchSession {
  branch?: string;
  worktreePath?: string;
}

type BranchStatus = Pick<GitStatus, "available" | "branch" | "headSha">;

const DETACHED_HEAD = "HEAD";

export function folderHeadValue(status: BranchStatus): string {
  if (status.branch !== DETACHED_HEAD) return status.branch;
  return status.headSha || DETACHED_HEAD;
}

export function branchMismatch(session: BranchSession | undefined, status: BranchStatus | null | undefined): BranchMismatch | null {
  if (!session?.branch || session.worktreePath) return null;
  if (!status?.available) return null;
  if (status.branch === session.branch) return null;
  return { sessionBranch: session.branch, folderBranch: status.branch, folderHead: folderHeadValue(status) };
}

export function activeBranchMismatch(
  session: BranchSession | undefined,
  status: BranchStatus | null | undefined,
  keptFolderHead: string | undefined
): BranchMismatch | null {
  const mismatch = branchMismatch(session, status);
  if (!mismatch || validKeptHead(keptFolderHead, status) !== undefined) return null;
  return mismatch;
}

export function validKeptHead(keptFolderHead: string | undefined, status: BranchStatus | null | undefined): string | undefined {
  if (keptFolderHead === undefined || !status?.available) return undefined;
  return folderHeadValue(status) === keptFolderHead ? keptFolderHead : undefined;
}

export function shouldResetKeptHead(keptFolderHead: string | undefined, status: BranchStatus | null | undefined): boolean {
  if (keptFolderHead === undefined || !status?.available) return false;
  return folderHeadValue(status) !== keptFolderHead;
}

export function currentCheckoutSessionIds(sessions: readonly (BranchSession & { id: string })[]): string[] {
  return sessions.filter((session) => !session.worktreePath).map((session) => session.id);
}
