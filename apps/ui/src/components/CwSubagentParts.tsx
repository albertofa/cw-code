import { useState } from "react";
import { Square } from "lucide-react";
import type { DriverKind, SubagentSummary } from "@cw-code/contracts";
import { harnessLabel } from "@cw-code/shared/harnessLabels";
import { DriverIcon } from "./DriverIcon.js";
import { ipcErrorMessage } from "./ipcError.js";
import { useNotifs } from "./Notifications.js";
import { subagentStateLabel } from "./subagents.js";
import { hasPendingRequests, type CwSubagentState } from "./cwSubagents.js";

const CLAMP_CHARS = 280;
const CLAMP_LINES = 4;

export function cwSubagentStateLabel(state: CwSubagentState): string {
  return state === "waiting" ? "Needs input" : subagentStateLabel(state);
}

export function isActiveState(state: CwSubagentState): boolean {
  return state === "running" || state === "waiting";
}

export function stopCwSubagent(subagentId: string): void {
  void window.cw.stopSubagent(subagentId).catch((err: unknown) => {
    useNotifs.getState().push({ kind: "error", title: "Could not stop the subagent", message: ipcErrorMessage(err) });
  });
}

export function HarnessTag({ driver }: { driver: DriverKind }) {
  return (
    <span className="cw-suba-harness">
      <DriverIcon driver={driver} size={12} />
      <span>{harnessLabel(driver)}</span>
    </span>
  );
}

export function StateDot({ state }: { state: CwSubagentState }) {
  const label = cwSubagentStateLabel(state);
  return <span className={`suba-dot ${state}`} role="img" aria-label={label} title={label} />;
}

export function PendingBadge({ summary }: { summary: Pick<SubagentSummary, "status" | "pendingRequests"> | undefined }) {
  if (!summary || !hasPendingRequests(summary)) return null;
  const count = summary.pendingRequests;
  const label = count === 1 ? "1 request waiting for you" : `${count} requests waiting for you`;
  return (
    <span className="suba-badge cw-suba-pending" title={label} aria-label={label}>
      {count} pending
    </span>
  );
}

export function StopSubagentButton({ subagentId, className = "icon-btn tool-side-btn" }: { subagentId: string; className?: string }) {
  return (
    <button type="button" className={className} title="Stop subagent" aria-label="Stop subagent" onClick={() => stopCwSubagent(subagentId)}>
      <Square size={12} aria-hidden="true" />
    </button>
  );
}

export function SubagentExcerpt({ text, label, error = false }: { text: string; label: string; error?: boolean }) {
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  const long = trimmed.length > CLAMP_CHARS || trimmed.split("\n").length > CLAMP_LINES;
  return (
    <div className="suba-excerpt">
      <div className={`tool-output-label${error ? " error" : ""}`}>{label}</div>
      <p className={`suba-excerpt-text${open ? " is-open" : ""}`}>{trimmed}</p>
      {long && (
        <button type="button" className="agents-more" onClick={() => setOpen((value) => !value)}>
          {open ? "Collapse" : `Show full ${label}`}
        </button>
      )}
    </div>
  );
}
