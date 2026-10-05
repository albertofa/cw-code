import { useEffect } from "react";
import type { DriverName } from "../cw.js";
import { useAppStore, DEFAULT_COMPOSER } from "../stores/appStore.js";
import { usePanelStore } from "../stores/panelStore.js";
import { ComposerView, type ComposerBackend } from "./ComposerView.js";
import { ContextRing } from "./ContextRing.js";

export function Composer({ sessionId, driver }: { sessionId: string; driver: DriverName }) {
  const prefs = useAppStore((s) => s.composerBySession[sessionId] ?? DEFAULT_COMPOSER);
  const busy = useAppStore((s) => s.busyTurns[sessionId] !== undefined);
  const projectId = useAppStore((s) => {
    for (const [pid, list] of Object.entries(s.sessionsByProject)) {
      if (list.some((session) => session.id === sessionId)) return pid;
    }
    return null;
  });
  const effectivePermissionMode = useAppStore((s) => {
    for (const list of Object.values(s.sessionsByProject)) {
      const match = list.find((session) => session.id === sessionId);
      if (match) return match.effectivePermissionMode;
    }
    return undefined;
  });

  const modelsRefreshKey = useAppStore((s) => s.settingsVersion);

  useEffect(() => {
    void useAppStore.getState().ensureComposer(sessionId);
  }, [sessionId]);

  const backend: ComposerBackend = {
    imageTarget: { sessionId, projectId: projectId ?? undefined },
    prefs,
    busy,
    effectivePermissionMode,
    loadModels: () => window.cw.listModels(sessionId),
    loadPermissions: () => window.cw.listPermissions(sessionId),
    loadFiles: () => window.cw.listFiles(sessionId),
    loadCommands: () => window.cw.listCommands(sessionId),
    savePrefs: (p) => {
      void useAppStore.getState().setComposerPrefs(sessionId, p);
    },
    send: (body, attachments, command) => useAppStore.getState().sendPrompt(body, attachments, command),
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
      modelsRefreshKey={modelsRefreshKey}
      usageSlot={<ContextRing sessionId={sessionId} driver={driver} />}
    />
  );
}
