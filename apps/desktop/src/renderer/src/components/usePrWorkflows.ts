import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { PrWorkflow } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { errorMessage } from "./errorMessage.js";

interface WorkflowsState {
  workflows: PrWorkflow[];
  error: string | null;
  version: number | null;
}

const NO_WORKFLOWS: PrWorkflow[] = [];

let state: WorkflowsState = { workflows: NO_WORKFLOWS, error: null, version: null };
let inflight: number | null = null;
const listeners = new Set<() => void>();

function publish(next: WorkflowsState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function load(version: number): void {
  inflight = version;
  window.cw
    .getSettings()
    .then((settings) => {
      if (inflight !== version) return;
      inflight = null;
      publish({ workflows: settings.prWorkflows, error: null, version });
    })
    .catch((err: unknown) => {
      if (inflight !== version) return;
      inflight = null;
      console.warn(`[github] could not load workflows: ${errorMessage(err)}`);
      publish({ ...state, error: errorMessage(err) });
    });
}

export function usePrWorkflows(): { workflows: PrWorkflow[]; error: string | null; reload: () => void } {
  const settingsVersion = useAppStore((s) => s.settingsVersion);
  const snapshot = useSyncExternalStore(subscribe, () => state);

  useEffect(() => {
    if (state.version !== settingsVersion && inflight !== settingsVersion) load(settingsVersion);
  }, [settingsVersion, snapshot.version]);

  const reload = useCallback(() => load(settingsVersion), [settingsVersion]);

  return { workflows: snapshot.workflows, error: snapshot.error, reload };
}
