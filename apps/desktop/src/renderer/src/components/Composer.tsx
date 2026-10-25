import { useEffect, type ReactNode } from "react";
import type { DriverName } from "../cw.js";
import { useAppStore, DEFAULT_COMPOSER } from "../stores/appStore.js";
import { usePanelStore } from "../stores/panelStore.js";
import { useSessionSkillsStore } from "../stores/sessionSkillsStore.js";
import { ComposerView, type ComposerBackend } from "./ComposerView.js";
import { useAppSettings } from "./useAppSettings.js";
import { useBranchMismatch } from "./useGit.js";
import { ContextRing } from "./ContextRing.js";
import { restoreConfirm } from "./sessionLifecycle.js";
import { useThreadEntry } from "./useThread.js";

export function Composer({ sessionId, driver, top }: { sessionId: string; driver: DriverName; top?: ReactNode }) {
  const prefs = useAppStore((s) => s.composerBySession[sessionId] ?? DEFAULT_COMPOSER);
  const prefsLoaded = useAppStore((s) => s.composerLoadedBySession[sessionId] === true);
  const busy = useThreadEntry(sessionId, "turn") != null;
  const projectId = useAppStore((s) => {
    for (const [pid, list] of Object.entries(s.sessionsByProject)) {
      if (list.some((session) => session.id === sessionId)) return pid;
    }
    return null;
  });
  const session = useAppStore((s) => {
    for (const list of Object.values(s.sessionsByProject)) {
      const match = list.find((item) => item.id === sessionId);
      if (match) return match;
    }
    return undefined;
  });
  const effectivePermissionMode = session?.effectivePermissionMode;

  const settings = useAppSettings();
  const mismatch = useBranchMismatch(sessionId);

  useEffect(() => {
    void useAppStore.getState().ensureComposer(sessionId);
  }, [sessionId]);

  const backend: ComposerBackend = {
    imageTarget: { sessionId, projectId: projectId ?? undefined },
    prefs,
    prefsLoaded,
    busy,
    effectivePermissionMode,
    branchGuard: {
      mismatch,
      switchBranch: async () => {
        if (mismatch) await window.cw.switchGitBranch(sessionId, mismatch.sessionBranch);
      },
      acceptFolderHead: () => window.cw.keepFolderHead(sessionId),
      refreshMismatch: () => window.cw.checkBranchMismatch(sessionId)
    },
    loadModels: () => window.cw.listModels(sessionId),
    loadPermissions: () => window.cw.listPermissions(sessionId),
    loadFiles: () => window.cw.listFiles(sessionId),
    loadCommands: () =>
      window.cw.listCommands(sessionId).then((list) => {
        useSessionSkillsStore.getState().publish(sessionId, list);
        return list;
      }),
    savePrefs: (p) => {
      void useAppStore.getState().setComposerPrefs(sessionId, p);
    },
    send: (body, attachments, opts) => useAppStore.getState().sendPromptTo(sessionId, body, attachments, opts),
    ...(session?.status === "resolved"
      ? { restore: { confirm: restoreConfirm(session), run: () => useAppStore.getState().restoreSession(sessionId) } }
      : {}),
    newSession: () => useAppStore.getState().startNewSession(driver),
    rename: (title) => useAppStore.getState().renameSession(sessionId, title),
    openTerminal: () => usePanelStore.getState().revealTab(sessionId, driver),
    savePasteImage: (mime, data) =>
      projectId
        ? window.cw.savePasteImage(projectId, mime, data)
        : Promise.reject(new Error("project not available")),
    interrupt: () => {
      void useAppStore.getState().interrupt();
    }
  };

  return (
    <ComposerView
      backend={backend}
      driver={driver}
      resetKey={sessionId}
      settings={settings}
      usageSlot={<ContextRing sessionId={sessionId} driver={driver} />}
      top={top}
    />
  );
}
