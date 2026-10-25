import type { BranchMismatch, GitStatus, GitTopicData } from "@cw-code/contracts";
import { gitTopic } from "@cw-code/shared/topics";
import { useTopicEntry, useTopicSelect } from "../server/topics.js";

function topicOf(sessionId: string | null | undefined): string | null {
  return sessionId ? gitTopic(sessionId) : null;
}

function useGitEntry<K extends keyof GitTopicData>(sessionId: string | null | undefined, key: K): GitTopicData[K] | null {
  return useTopicEntry<GitTopicData[K]>(topicOf(sessionId), key) ?? null;
}

function holdOnly(): null {
  return null;
}

export function useHoldGit(sessionId: string | null | undefined): void {
  useTopicSelect(topicOf(sessionId), holdOnly);
}

export function useGitStatus(sessionId: string | null | undefined): GitStatus | null {
  return useGitEntry(sessionId, "status");
}

export function useGitError(sessionId: string | null | undefined): string | null {
  return useTopicSelect<string | null, GitTopicData>(topicOf(sessionId), (state) =>
    state?.status === "error" ? (state.error ?? "Git topic unavailable") : (state?.data.error ?? null)
  );
}

export function useBranchMismatch(sessionId: string | null | undefined): BranchMismatch | null {
  return useGitEntry(sessionId, "mismatch");
}

export function useBranchMismatched(sessionId: string | null | undefined): boolean {
  return useGitEntry(sessionId, "branchMismatched") ?? false;
}

export function useKeptFolderHead(sessionId: string | null | undefined): string | null {
  return useGitEntry(sessionId, "keptFolderHead");
}

export function refreshGit(sessionId: string): void {
  window.cw.refreshGit(sessionId).catch((err: Error) => console.warn(`git refresh failed for ${sessionId}: ${err.message}`));
}
