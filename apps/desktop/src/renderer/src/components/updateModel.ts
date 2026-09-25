import type { UpdateChannel, UpdateState } from "../cw.js";

export type UpdateIndicatorAction = "download" | "restart" | "retry-check" | "retry-download";

export interface UpdateIndicatorView {
  key: string;
  tone: "info" | "error";
  title: string;
  detail: string | null;
  action: UpdateIndicatorAction | null;
  actionLabel: string | null;
  busyLabel: string | null;
  progress: number | null;
}

export interface UpdateInstallTarget {
  version: string;
  channel: UpdateChannel;
}

export const CHANNEL_LABELS: Record<UpdateChannel, string> = { stable: "Stable", alpha: "Alpha" };

export function installTarget(state: UpdateState | null): UpdateInstallTarget | null {
  if (!state || state.phase !== "ready" || state.downloadedVersion === null) return null;
  return { version: state.downloadedVersion, channel: state.channel };
}

export function matchesInstallTarget(state: UpdateState, target: UpdateInstallTarget): boolean {
  return state.phase === "ready" && state.downloadedVersion === target.version && state.channel === target.channel;
}

function stateKey(state: UpdateState, restartPending: boolean): string {
  return [state.phase, state.availableVersion, state.downloadedVersion, state.error?.context, state.error?.message, restartPending].join("|");
}

export function updateIndicatorView(state: UpdateState | null, restartPending: boolean): UpdateIndicatorView | null {
  if (!state) return null;
  const key = stateKey(state, restartPending);
  const base = { key, tone: "info" as const, detail: null, action: null, actionLabel: null, busyLabel: null, progress: null };
  if (restartPending || state.phase === "installing") {
    return { ...base, title: "Restarting to update", busyLabel: "cw-code is getting ready to restart" };
  }
  switch (state.phase) {
    case "available":
      return {
        ...base,
        title: state.availableVersion ? `cw-code ${state.availableVersion} is available` : "An update is available",
        detail: state.autoDownload ? "Downloading in the background" : null,
        action: "download",
        actionLabel: "Download"
      };
    case "downloading": {
      const percent = Math.round(state.progress?.percent ?? 0);
      return {
        ...base,
        title: `Downloading ${state.availableVersion ?? "update"}`,
        detail: `${percent}%`,
        busyLabel: "The download is in progress",
        progress: percent
      };
    }
    case "ready": {
      const failedInstall = state.error?.context === "install";
      return {
        ...base,
        tone: failedInstall ? "error" : "info",
        title: failedInstall ? "The update could not be installed" : state.downloadedVersion ? `cw-code ${state.downloadedVersion} is ready` : "The update is ready",
        detail: failedInstall ? (state.error?.message ?? null) : "Restart when you are ready. Nothing restarts without you.",
        action: "restart",
        actionLabel: failedInstall ? "Try again" : "Update and restart"
      };
    }
    case "error": {
      const retryable = state.error?.retryable !== false;
      const download = state.error?.context === "download";
      return {
        ...base,
        tone: "error",
        title: download ? "The update download failed" : "Could not check for updates",
        detail: [state.error?.message, retryable ? null : "Retrying will not help."].filter(Boolean).join(" ") || null,
        action: retryable ? (download ? "retry-download" : "retry-check") : null,
        actionLabel: retryable ? "Retry" : null
      };
    }
    default:
      return null;
  }
}

export function updateStatusText(state: UpdateState | null): string {
  if (!state) return "Loading update status…";
  switch (state.phase) {
    case "disabled":
      return state.disabledReason ?? "Updates are disabled";
    case "idle":
      return "Not checked yet";
    case "checking":
      return "Checking for updates…";
    case "up-to-date":
      return "cw-code is up to date";
    case "available":
      return `Version ${state.availableVersion ?? "unknown"} is available`;
    case "downloading":
      return `Downloading ${state.availableVersion ?? "update"} (${Math.round(state.progress?.percent ?? 0)}%)`;
    case "ready":
      return `Version ${state.downloadedVersion ?? "unknown"} is downloaded and ready to install`;
    case "installing":
      return "Restarting to install the update…";
    case "error":
      return state.error?.context === "download" ? "The last download failed" : "The last check failed";
  }
}

export function formatCheckedAt(checkedAt: number | null, now: number): string {
  if (checkedAt === null) return "Never";
  const minutes = Math.round((now - checkedAt) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(checkedAt).toLocaleString();
}
