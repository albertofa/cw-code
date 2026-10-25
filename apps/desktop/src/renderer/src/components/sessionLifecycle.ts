import { useCallback, type ReactNode } from "react";
import type { Session } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { useConfirm, type ConfirmRequest } from "./ConfirmDialog.js";

export function restoreLosesWork(session: Pick<Session, "worktreePath" | "resolvedCheckout">): boolean {
  return !session.worktreePath && session.resolvedCheckout?.kind !== "root";
}

export function restoreConfirm(session: Pick<Session, "worktreePath" | "resolvedCheckout">): ConfirmRequest | null {
  if (!restoreLosesWork(session)) return null;
  return {
    title: "Restore session?",
    message:
      "Its worktree was removed when the session was resolved, and uncommitted changes from it are lost. Restoring creates a fresh worktree on the session branch, or on a new branch from the base if that branch was deleted, so unpushed commits may be gone too. The conversation is kept.",
    confirmLabel: "Restore",
    danger: true
  };
}

export const ARCHIVE_CONFIRM: ConfirmRequest = {
  title: "Archive session?",
  message:
    "Archiving stops the CLI session and its terminals, removes its worktree and deletes its cw-code branch when nothing else uses them, and hides the session from cw-code. Archived sessions cannot be restored from the app.",
  confirmLabel: "Archive",
  danger: true
};

export function useRestoreBeforeSend(): { ensureOpen: (sessionId: string) => Promise<boolean>; dialog: ReactNode } {
  const { confirm, dialog } = useConfirm();
  const ensureOpen = useCallback(
    async (sessionId: string) => {
      const session = Object.values(useAppStore.getState().sessionsByProject)
        .flat()
        .find((item) => item.id === sessionId);
      if (session?.status !== "resolved") return true;
      const request = restoreConfirm(session);
      if (request && !(await confirm(request))) return false;
      await useAppStore.getState().restoreSession(sessionId);
      return true;
    },
    [confirm]
  );
  return { ensureOpen, dialog };
}
