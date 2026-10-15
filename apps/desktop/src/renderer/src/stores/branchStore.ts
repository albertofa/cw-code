import { create } from "zustand";
import { useAppStore } from "./appStore.js";

interface BranchState {
  keptFolderBranchBySession: Record<string, string>;
  keepFolderBranch(sessionId: string, folderBranch: string): void;
  switchToSessionBranch(sessionId: string, sessionBranch: string): Promise<void>;
}

export const useBranchStore = create<BranchState>((set, get) => ({
  keptFolderBranchBySession: {},

  keepFolderBranch(sessionId: string, folderBranch: string) {
    set({ keptFolderBranchBySession: { ...get().keptFolderBranchBySession, [sessionId]: folderBranch } });
  },

  async switchToSessionBranch(sessionId: string, sessionBranch: string) {
    try {
      await window.cw.switchGitBranch(sessionId, sessionBranch);
    } finally {
      await useAppStore.getState().refreshGitStatus(sessionId);
    }
  }
}));
