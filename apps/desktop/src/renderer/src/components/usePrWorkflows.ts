import { useEffect, useState } from "react";
import type { PrWorkflow } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { errorMessage } from "./errorMessage.js";

const NO_WORKFLOWS: PrWorkflow[] = [];

let cached: { version: number; promise: Promise<PrWorkflow[]> } | null = null;

function loadWorkflows(version: number): Promise<PrWorkflow[]> {
  if (cached?.version === version) return cached.promise;
  const promise = window.cw.getSettings().then((settings) => settings.prWorkflows);
  const entry = { version, promise };
  cached = entry;
  promise.catch(() => {
    if (cached === entry) cached = null;
  });
  return promise;
}

export function usePrWorkflows(): PrWorkflow[] {
  const settingsVersion = useAppStore((s) => s.settingsVersion);
  const [workflows, setWorkflows] = useState<PrWorkflow[]>(NO_WORKFLOWS);

  useEffect(() => {
    let active = true;
    loadWorkflows(settingsVersion)
      .then((next) => {
        if (active) setWorkflows(next);
      })
      .catch((err: unknown) => console.warn(`[github] could not load workflows: ${errorMessage(err)}`));
    return () => {
      active = false;
    };
  }, [settingsVersion]);

  return workflows;
}
