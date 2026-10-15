import { create } from "zustand";
import { useAppStore } from "./appStore.js";

interface BranchState {
  keptFolderBranchBySession: Record<string, string>;
  keepFolderBranch(sessionId: string, folderBranch: string): void;
  clearKeptFolderBranch(sessionId: string): void;
  switchToSessionBranch(sessionId: string, sessionBranch: string): Promise<void>;
}

export const useBranchStore = create<BranchState>((set, get) => ({
  keptFolderBranchBySession: {},

  keepFolderBranch(sessionId: string, folderBranch: string) {
    set({ keptFolderBranchBySession: { ...get().keptFolderBranchBySession, [sessionId]: folderBranch } });
  },

  clearKeptFolderBranch(sessionId: string) {
    const current = get().keptFolderBranchBySession;
    if (!(sessionId in current)) return;
    const next = { ...current };
    delete next[sessionId];
    set({ keptFolderBranchBySession: next });
  },

  async switchToSessionBranch(sessionId: string, sessionBranch: string) {
    try {
      await window.cw.switchGitBranch(sessionId, sessionBranch);
    } finally {
      await useAppStore.getState().refreshGitStatus(sessionId);
    }
  }
}));
