import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { DriverName } from "../cw.js";
import { useNotifs } from "./Notifications.js";
import { ipcErrorMessage } from "./ipcError.js";

/** Forces a plan-limits refresh for one harness; spins while the server reports it loading. */
export function PlanRefreshButton({ driver, loading }: { driver: DriverName; loading: boolean }) {
  const [pending, setPending] = useState(false);
  const busy = pending || loading;
  const refresh = async () => {
    setPending(true);
    try {
      await window.cw.refreshAccountUsage(true, [driver]);
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title: "Could not refresh plan limits", message: ipcErrorMessage(err) });
    } finally {
      setPending(false);
    }
  };
  return (
    <button
      type="button"
      className={`icon-btn usage-refresh-btn plan-refresh-btn${busy ? " is-busy" : ""}`}
      title="Refresh plan limits"
      aria-label="Refresh plan limits"
      disabled={busy}
      onClick={() => void refresh()}
    >
      <RefreshCw size={13} className={busy ? "spin" : undefined} aria-hidden="true" />
    </button>
  );
}
