import { useAppStore } from "../stores/appStore.js";
import type { DriverName } from "../cw.js";
import { DriverIcon } from "./DriverIcon.js";
import { ComposerView, type ComposerBackend } from "./ComposerView.js";

const HARNESS: Array<{ id: DriverName; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "opencode", label: "OpenCode" },
  { id: "codex", label: "Codex" }
];

export function NewThread({
  projectId,
  projectName,
  driver,
  onDriverChange
}: {
  projectId: string;
  projectName: string;
  driver: DriverName;
  onDriverChange: (d: DriverName) => void;
}) {
  const store = useAppStore();
  const prefs = useAppStore((s) => s.pendingPrefs);
  const modelsRefreshKey = useAppStore((s) => s.settingsVersion);

  const backend: ComposerBackend = {
    imageTarget: { projectId },
    prefs,
    busy: false,
    loadModels: () => window.cw.listModelsFor(projectId, driver),
    loadFiles: () => window.cw.listProjectFiles(projectId),
    savePrefs: (p) => store.setPendingPrefs(p),
    send: (body, attachments) => store.sendPendingPrompt(body, attachments),
    savePasteImage: (mime, data) => window.cw.savePasteImage(projectId, mime, data),
    interrupt: () => {}
  };

  return (
    <div className="newthread">
      <h1 className="newthread-title">
        What should we build in <span>{projectName}</span>?
      </h1>
      <div className="newthread-composer">
        <ComposerView backend={backend} driver={driver} resetKey={`pending:${projectId}`} modelsRefreshKey={modelsRefreshKey} />
      </div>
      <div className="harness-row" role="group" aria-label="Agentic harness">
        {HARNESS.map((h) => (
          <button
            key={h.id}
            className={`harness-btn ${h.id}${h.id === driver ? " active" : ""}`}
            onClick={() => onDriverChange(h.id)}
            aria-pressed={h.id === driver}
            title={`Use ${h.label}`}
          >
            <DriverIcon driver={h.id} size={14} />
            {h.label}
          </button>
        ))}
      </div>
    </div>
  );
}
