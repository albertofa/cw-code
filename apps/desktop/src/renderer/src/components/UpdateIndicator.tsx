import { useState } from "react";
import { useAppStore } from "../stores/appStore.js";
import { restartToUpdate, runUpdateAction } from "../stores/updateFlow.js";
import { updateIndicatorView, type UpdateIndicatorAction } from "./updateModel.js";

function perform(action: UpdateIndicatorAction): Promise<void> {
  const store = useAppStore.getState();
  switch (action) {
    case "restart":
      return restartToUpdate();
    case "download":
    case "retry-download":
      return runUpdateAction(() => store.downloadUpdate(), "Could not download the update");
    case "retry-check":
      return runUpdateAction(() => store.checkForUpdates(), "Could not check for updates");
  }
}

export function UpdateIndicator() {
  const state = useAppStore((s) => s.updates);
  const restartPending = useAppStore((s) => s.updateRestartPending);
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const view = updateIndicatorView(state, restartPending);
  if (!view || view.key === hiddenKey) return null;

  const run = async () => {
    if (!view.action || running) return;
    setRunning(true);
    try {
      await perform(view.action);
    } finally {
      setRunning(false);
    }
  };

  const disabledReason = view.busyLabel ?? (running ? "Working on it…" : null);

  return (
    <section className={`notif ${view.tone}`} style={{ margin: "0 8px 8px" }} aria-label="cw-code update" aria-live="polite">
      <div className="notif-head">
        <span className="notif-title" title={view.title}>
          {view.title}
        </span>
      </div>
      {view.detail && <div className="notif-msg">{view.detail}</div>}
      {view.progress !== null && (
        <div
          className="usage-track thin"
          role="progressbar"
          aria-label="Update download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.progress}
        >
          <i style={{ width: `${view.progress}%` }} />
        </div>
      )}
      <div className="notif-actions">
        <button type="button" className="btn" onClick={() => setHiddenKey(view.key)} disabled={restartPending}>
          Later
        </button>
        {view.actionLabel ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void run()}
            disabled={disabledReason !== null}
            title={disabledReason ?? undefined}
          >
            {view.actionLabel}
          </button>
        ) : (
          view.busyLabel && (
            <button type="button" className="btn" disabled title={view.busyLabel}>
              {view.progress !== null ? "Downloading…" : "Restarting…"}
            </button>
          )
        )}
      </div>
    </section>
  );
}
