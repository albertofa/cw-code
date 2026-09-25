import { useEffect, useState, type ReactNode } from "react";
import type { StartupState } from "@cw-code/contracts";
import { ipcErrorMessage } from "./ipcError.js";
import { RecoveryScreen } from "./RecoveryScreen.js";

type GateState = { phase: "loading" } | { phase: "error"; message: string } | { phase: "loaded"; state: StartupState };

export function StartupGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<GateState>(() => (window.cw ? { phase: "loading" } : { phase: "loaded", state: { mode: "ready" } }));

  useEffect(() => {
    if (!window.cw) return;
    let active = true;
    window.cw
      .getStartupState()
      .then((state) => {
        if (active) setGate({ phase: "loaded", state });
      })
      .catch((err) => {
        if (active) setGate({ phase: "error", message: ipcErrorMessage(err) });
      });
    return () => {
      active = false;
    };
  }, []);

  if (gate.phase === "loading") return null;
  if (gate.phase === "error") return <div className="preload-error">cw-code could not determine its startup state: {gate.message}</div>;
  if (gate.state.mode === "recovery") return <RecoveryScreen issues={gate.state.issues} dataDir={gate.state.dataDir} />;
  return <>{children}</>;
}
