import { create } from "zustand";
import type { GitStatus } from "../cw.js";
import { useAppStore } from "./appStore.js";
import { activeBranchMismatch, folderHeadValue, shouldResetKeptHead, type BranchMismatch } from "../components/sessionBranch.js";

interface BranchState {
  keptFolderHeadBySession: Record<string, string>;
  keepFolderHead(sessionId: string, folderHead: string): void;
  clearKeptFolderHead(sessionId: string): void;
  reconcileKeptHead(sessionId: string, status: GitStatus): void;
  switchToSessionBranch(sessionId: string, sessionBranch: string): Promise<void>;
  acceptFolderHead(sessionId: string): Promise<string | null>;
  refreshMismatch(sessionId: string): Promise<BranchMismatch | null>;
}

export const useBranchStore = create<BranchState>((set, get) => ({
  keptFolderHeadBySession: {},

  keepFolderHead(sessionId: string, folderHead: string) {
    set({ keptFolderHeadBySession: { ...get().keptFolderHeadBySession, [sessionId]: folderHead } });
  },

  clearKeptFolderHead(sessionId: string) {
    const current = get().keptFolderHeadBySession;
    if (!(sessionId in current)) return;
    const next = { ...current };
    delete next[sessionId];
    set({ keptFolderHeadBySession: next });
  },

  reconcileKeptHead(sessionId, status) {
    if (shouldResetKeptHead(get().keptFolderHeadBySession[sessionId], status)) get().clearKeptFolderHead(sessionId);
  },

  async switchToSessionBranch(sessionId: string, sessionBranch: string) {
    const app = useAppStore.getState();
    try {
      await window.cw.switchGitBranch(sessionId, sessionBranch);
    } finally {
      await app.refreshProjectCheckoutGitStatus(sessionId);
    }
  },

  async acceptFolderHead(sessionId: string) {
    await useAppStore.getState().refreshGitStatus(sessionId);
    const status = useAppStore.getState().gitStatusBySession[sessionId];
    if (!status?.available) return null;
    const head = folderHeadValue(status);
    get().keepFolderHead(sessionId, head);
    return head;
  },

  async refreshMismatch(sessionId: string) {
    await useAppStore.getState().refreshGitStatus(sessionId);
    const app = useAppStore.getState();
    const session = Object.values(app.sessionsByProject)
      .flat()
      .find((item) => item.id === sessionId);
    return activeBranchMismatch(session, app.gitStatusBySession[sessionId], get().keptFolderHeadBySession[sessionId]);
  }
}));
