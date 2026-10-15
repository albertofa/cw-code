import { useEffect, useMemo } from "react";
import { useAppStore } from "../stores/appStore.js";
import { useBranchStore } from "../stores/branchStore.js";
import { activeBranchMismatch, shouldResetKeptBranch, type BranchMismatch } from "./sessionBranch.js";
import { findSession } from "./useLinkedPr.js";

export interface SessionBranchMismatch {
  mismatch: BranchMismatch | null;
  projectName: string;
}

export function useBranchMismatch(sessionId: string): SessionBranchMismatch {
  const session = useAppStore((s) => findSession(s.sessionsByProject, sessionId));
  const status = useAppStore((s) => s.gitStatusBySession[sessionId]);
  const projectName = useAppStore((s) => s.projects.find((project) => project.id === session?.projectId)?.name ?? "The project");
  const kept = useBranchStore((s) => s.keptFolderBranchBySession[sessionId]);
  const resetKept = shouldResetKeptBranch(kept, status);
  useEffect(() => {
    if (resetKept) useBranchStore.getState().clearKeptFolderBranch(sessionId);
  }, [resetKept, sessionId]);
  return useMemo(
    () => ({ mismatch: activeBranchMismatch(session, status, kept), projectName }),
    [session, status, kept, projectName]
  );
}
