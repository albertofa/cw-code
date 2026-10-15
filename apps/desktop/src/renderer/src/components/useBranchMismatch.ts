import { useMemo } from "react";
import { useAppStore } from "../stores/appStore.js";
import { useBranchStore } from "../stores/branchStore.js";
import { activeBranchMismatch, type BranchMismatch } from "./sessionBranch.js";
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
  return useMemo(
    () => ({ mismatch: activeBranchMismatch(session, status, kept), projectName }),
    [session, status, kept, projectName]
  );
}
