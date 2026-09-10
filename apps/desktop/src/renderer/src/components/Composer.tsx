import { useEffect } from "react";
import type { DriverName } from "../cw.js";
import { useAppStore, DEFAULT_COMPOSER } from "../stores/appStore.js";
import { ComposerView, type ComposerBackend } from "./ComposerView.js";

export function Composer({ sessionId, driver }: { sessionId: string; driver: DriverName }) {
  const store = useAppStore();
  const prefs = useAppStore((s) => s.composerBySession[sessionId] ?? DEFAULT_COMPOSER);
  const busy = useAppStore((s) => s.busyTurns[sessionId] !== undefined);

  useEffect(() => {
    void store.ensureComposer(sessionId);
  }, [sessionId]);

  const backend: ComposerBackend = {
    prefs,
    busy,
    loadModels: () => window.cw.listModels(sessionId),
    loadFiles: () => window.cw.listFiles(sessionId),
    savePrefs: (p) => {
      void store.setComposerPrefs(sessionId, p);
    },
    send: (body, attachments) => store.sendPrompt(body, attachments),
    interrupt: () => {
      void store.interrupt();
    }
  };

  return <ComposerView backend={backend} driver={driver} resetKey={sessionId} modelsRefreshKey={useAppStore((s) => s.settingsVersion)} />;
}
