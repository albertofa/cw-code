import type { BranchMismatch } from "@cw-code/contracts";
import type { GitStatus } from "../cw.js";

export type { BranchMismatch };

interface BranchSession {
  branch?: string;
  worktreePath?: string;
}

type BranchStatus = Pick<GitStatus, "available" | "branch" | "headSha">;

const DETACHED_HEAD = "HEAD";
const MISMATCH_MARKER = "[cw-branch-mismatch]";
const LINE_BREAK = /\r?\n/;

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

export function parseBranchMismatchError(message: string): { text: string } | null {
  const index = message.indexOf(MISMATCH_MARKER);
  if (index < 0) return null;
  const text = message.slice(index + MISMATCH_MARKER.length).split(LINE_BREAK)[0].trim();
  return text ? { text } : null;
}

export function isDetachedHead(mismatch: BranchMismatch): boolean {
  return mismatch.folderBranch === DETACHED_HEAD;
}

export function mismatchSentence(projectName: string, mismatch: BranchMismatch): string {
  const where = isDetachedHead(mismatch) ? "in a detached HEAD state" : `on ${mismatch.folderBranch}`;
  return `${projectName} is ${where}, not ${isDetachedHead(mismatch) ? "on " : ""}this session's branch ${mismatch.sessionBranch}.`;
}

export function keepLabel(mismatch: BranchMismatch): string {
  return isDetachedHead(mismatch) ? "Keep working here" : `Keep working on ${mismatch.folderBranch}`;
}

export function sendHereLabel(mismatch: BranchMismatch): string {
  return isDetachedHead(mismatch) ? "Send here" : `Send on ${mismatch.folderBranch}`;
}
