import type { DockableTabId, PrCiState } from "@cw-code/contracts";
import type { DriverName } from "../cw.js";

export type RailDotTone = "success" | "danger" | "warning";

export function railGroups(driver: DriverName | undefined, hasPr: boolean, hasPreview: boolean): DockableTabId[][] {
  const groups: DockableTabId[][] = [
    ["overview", "diff", ...(hasPr ? (["pr"] as const) : []), "files", "agents"],
    ["shell", ...(driver ? [driver] : [])]
  ];
  if (hasPreview) groups.push(["preview"]);
  return groups;
}

export function checksTone(states: readonly PrCiState[]): RailDotTone | null {
  if (states.includes("failing")) return "danger";
  if (states.includes("pending")) return "warning";
  if (states.includes("passing")) return "success";
  return null;
}

export function checkCountsTone(checks: { total: number; failed: number; pending: number } | undefined): RailDotTone | null {
  if (!checks || checks.total === 0) return null;
  if (checks.failed > 0) return "danger";
  if (checks.pending > 0) return "warning";
  return "success";
}

export function gitDiffSummary(status: { dirtyCount: number; addedLines: number; deletedLines: number } | undefined): string | undefined {
  if (!status || status.dirtyCount === 0) return undefined;
  const files = `${status.dirtyCount} ${status.dirtyCount === 1 ? "file" : "files"}`;
  return `${files} · +${status.addedLines} \u2212${status.deletedLines}`;
}
