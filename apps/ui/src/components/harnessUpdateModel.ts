import type { DriverKind, HarnessUpdateInfo, HarnessUpdates } from "@cw-code/contracts";
import { harnessLabel } from "@cw-code/shared/harnessLabels";

export const SUCCESS_VISIBLE_MS = 3000;

export interface HarnessUpdateView {
  key: string;
  tone: "info" | "warning" | "error" | "success";
  title: string;
  lines: string[];
  action: "update" | "settings" | null;
  actionLabel: string | null;
  busy: boolean;
  autoHideMs: number | null;
  targets: DriverKind[];
}

const IDLE_VIEW = { action: null, actionLabel: null, busy: false, autoHideMs: null, targets: [] as DriverKind[] };

function viewKey(items: HarnessUpdateInfo[]): string {
  return items
    .map((item) => [item.binary, item.status, item.currentVersion, item.latestVersion, item.phase, item.finishedAt, item.canUpdate].join(":"))
    .join("|");
}

function names(items: HarnessUpdateInfo[]): string {
  return items.map((item) => harnessLabel(item.binary)).join(", ");
}

function phaseLines(items: HarnessUpdateInfo[]): string[] {
  return items.map((item) => item.phaseMessage).filter((line): line is string => line !== null && line !== "");
}

function problemTitle(failed: HarnessUpdateInfo[], unchanged: HarnessUpdateInfo[]): string {
  const total = failed.length + unchanged.length;
  if (total > 1) {
    if (unchanged.length === 0) return `${total} harness updates failed`;
    return failed.length === 0 ? `${total} harnesses still need an update` : `${total} harness updates need attention`;
  }
  return failed.length === 1 ? `${names(failed)} update failed` : `${names(unchanged)} still needs an update`;
}

export function harnessUpdateView(updates: HarnessUpdates | undefined, now: number): HarnessUpdateView | null {
  if (!updates) return null;
  const items = Object.values(updates);
  const key = viewKey(items);

  const active = items.filter((item) => item.phase === "queued" || item.phase === "running");
  if (active.length > 0) {
    return {
      ...IDLE_VIEW,
      key,
      tone: "info",
      title: active.length === 1 ? `Updating ${names(active)}…` : `Updating ${active.length} harnesses…`,
      lines: phaseLines(active),
      busy: true
    };
  }

  const failed = items.filter((item) => item.phase === "failed" && item.finishedAt !== null);
  const unchanged = items.filter((item) => item.phase === "unchanged" && item.finishedAt !== null);
  if (failed.length + unchanged.length > 0) {
    return {
      ...IDLE_VIEW,
      key,
      tone: failed.length > 0 ? "error" : "warning",
      title: problemTitle(failed, unchanged),
      lines: phaseLines([...failed, ...unchanged]),
      action: "settings",
      actionLabel: "Details",
      targets: [...failed, ...unchanged].map((item) => item.binary)
    };
  }

  const fresh = items.filter((item) => item.phase === "succeeded" && item.finishedAt !== null && now - item.finishedAt < SUCCESS_VISIBLE_MS);
  if (fresh.length > 0) {
    const remaining = Math.max(...fresh.map((item) => SUCCESS_VISIBLE_MS - (now - (item.finishedAt ?? now))));
    return {
      ...IDLE_VIEW,
      key,
      tone: "success",
      title: fresh.length === 1 ? `${names(fresh)} updated to ${fresh[0]?.currentVersion ?? "the latest version"}` : `${fresh.length} harnesses updated`,
      lines: ["New turns use the updated version."],
      autoHideMs: remaining
    };
  }

  const behind = items.filter((item) => item.status === "behind");
  if (behind.length > 0) {
    const updatable = behind.filter((item) => item.canUpdate);
    const canRun = updatable.length > 0;
    return {
      ...IDLE_VIEW,
      key,
      tone: "info",
      title: behind.length === 1 ? "Harness update available" : `${behind.length} harness updates available`,
      lines: behind.map((item) => `${harnessLabel(item.binary)} ${item.currentVersion ?? "?"} → ${item.latestVersion ?? "?"}`),
      action: canRun ? "update" : "settings",
      actionLabel: canRun ? "Update" : "Open settings",
      targets: (canRun ? updatable : behind).map((item) => item.binary)
    };
  }

  return null;
}
