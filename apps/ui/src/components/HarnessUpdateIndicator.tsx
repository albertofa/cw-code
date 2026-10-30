import { useEffect, useState } from "react";
import type { HarnessUpdates } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { useTopicEntry } from "../server/topics.js";
import { usePrStore } from "../stores/prStore.js";
import { errorMessage } from "./errorMessage.js";
import { harnessUpdateView } from "./harnessUpdateModel.js";
import { useNotifs } from "./Notifications.js";

export function HarnessUpdateIndicator() {
  const updates = useTopicEntry<HarnessUpdates>(APP_TOPIC, "harnessUpdates");
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const view = harnessUpdateView(updates, Date.now());
  const key = view?.key ?? null;
  const autoHideMs = view?.autoHideMs ?? null;

  useEffect(() => {
    if (autoHideMs === null || key === null) return;
    const timer = setTimeout(() => setHiddenKey(key), autoHideMs);
    return () => clearTimeout(timer);
  }, [key, autoHideMs]);

  if (!view || view.key === hiddenKey) return null;

  const run = async () => {
    if (view.action === "settings") {
      usePrStore.getState().openSettings(undefined, view.targets[0]);
      return;
    }
    if (view.action !== "update" || running) return;
    setRunning(true);
    try {
      await window.cw.updateHarnesses(view.targets);
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title: "Could not start the harness update", message: errorMessage(err) });
    } finally {
      setRunning(false);
    }
  };

  const cancel = () => {
    window.cw.cancelHarnessUpdates(view.cancelTargets).catch((err: unknown) => {
      useNotifs.getState().push({ kind: "error", title: "Could not cancel the harness update", message: errorMessage(err) });
    });
  };

  const starting = running && view.action === "update";

  return (
    <section className={`notif ${view.tone}`} style={{ margin: "0 8px 8px" }} aria-label="Harness update">
      <div className="notif-head" aria-live="polite">
        <span className="notif-title" title={view.title}>
          {view.title}
        </span>
      </div>
      {view.lines.length > 0 && (
        <div className="notif-msg">
          {view.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
      <div className="notif-actions">
        <button type="button" className="btn" onClick={() => setHiddenKey(view.key)}>
          Later
        </button>
        {view.cancelTargets.length > 0 && (
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
        )}
        {view.actionLabel && (
          <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={starting}>
            {starting ? "Starting…" : view.actionLabel}
          </button>
        )}
      </div>
    </section>
  );
}
