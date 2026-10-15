import type { GitStatus } from "../cw.js";

export interface BranchMismatch {
  sessionBranch: string;
  folderBranch: string;
}

interface BranchSession {
  branch?: string;
  worktreePath?: string;
}

type BranchStatus = Pick<GitStatus, "available" | "branch">;

export function branchMismatch(session: BranchSession | undefined, status: BranchStatus | null | undefined): BranchMismatch | null {
  if (!session?.branch || session.worktreePath) return null;
  if (!status?.available) return null;
  if (status.branch === session.branch) return null;
  return { sessionBranch: session.branch, folderBranch: status.branch };
}

export function activeBranchMismatch(
  session: BranchSession | undefined,
  status: BranchStatus | null | undefined,
  keptFolderBranch: string | undefined
): BranchMismatch | null {
  const mismatch = branchMismatch(session, status);
  if (!mismatch || mismatch.folderBranch === keptFolderBranch) return null;
  return mismatch;
}
