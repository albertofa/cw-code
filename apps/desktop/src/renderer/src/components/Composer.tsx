import { useEffect } from "react";
import type { DriverName } from "../cw.js";
import { useAppStore, DEFAULT_COMPOSER } from "../stores/appStore.js";
import { ComposerView, type ComposerBackend } from "./ComposerView.js";

export function Composer({ sessionId, driver }: { sessionId: string; driver: DriverName }) {
  const store = useAppStore();
  const prefs = useAppStore((s) => s.composerBySession[sessionId] ?? DEFAULT_COMPOSER);
  const busy = useAppStore((s) => s.busyTurns[sessionId] !== undefined);
  const projectId = useAppStore((s) => {
    for (const [pid, list] of Object.entries(s.sessionsByProject)) {
      if (list.some((session) => session.id === sessionId)) return pid;
    }
    return null;
  });

  useEffect(() => {
    void store.ensureComposer(sessionId);
  }, [sessionId]);

  const backend: ComposerBackend = {
    imageTarget: { sessionId, projectId: projectId ?? undefined },
    prefs,
    busy,
    loadModels: () => window.cw.listModels(sessionId),
    loadPermissions: () => window.cw.listPermissions(sessionId),
    loadFiles: () => window.cw.listFiles(sessionId),
    savePrefs: (p) => {
      void store.setComposerPrefs(sessionId, p);
    },
    send: (body, attachments) => store.sendPrompt(body, attachments),
    savePasteImage: (mime, data) =>
      projectId
        ? window.cw.savePasteImage(projectId, mime, data)
        : Promise.reject(new Error("project not available")),
    interrupt: () => {
      void store.interrupt();
    }
  };

  return <ComposerView backend={backend} driver={driver} resetKey={sessionId} modelsRefreshKey={useAppStore((s) => s.settingsVersion)} />;
}
