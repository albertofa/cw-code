import type { BranchMismatch } from "@cw-code/contracts";

export type { BranchMismatch };

const DETACHED_HEAD = "HEAD";
const MISMATCH_MARKER = "[cw-branch-mismatch]";
const LINE_BREAK = /\r?\n/;

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
