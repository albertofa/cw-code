import type { UpdateState } from "../cw.js";

export const PROGRESS_RENDER_INTERVAL_MS = 500;
export const PROGRESS_RENDER_STEP_PERCENT = 2;

const COMPARED_KEYS = [
  "phase",
  "runningVersion",
  "channel",
  "availableVersion",
  "downloadedVersion",
  "releaseName",
  "releaseNotes",
  "releaseDate",
  "checkedAt",
  "disabledReason",
  "autoDownload"
] as const satisfies ReadonlyArray<keyof UpdateState>;

function sameError(a: UpdateState["error"], b: UpdateState["error"]): boolean {
  if (a === null || b === null) return a === b;
  return a.message === b.message && a.context === b.context && a.retryable === b.retryable;
}

function isProgressOnlyChange(current: UpdateState, next: UpdateState): boolean {
  if (current.phase !== "downloading" || next.phase !== "downloading") return false;
  return COMPARED_KEYS.every((key) => current[key] === next[key]) && sameError(current.error, next.error);
}

export function shouldApplyUpdateState(current: UpdateState | null, next: UpdateState, lastAppliedAt: number, now: number): boolean {
  if (!current) return true;
  if (next.seq < current.seq) return false;
  if (!isProgressOnlyChange(current, next)) return true;
  const previous = current.progress?.percent ?? 0;
  const percent = next.progress?.percent ?? 0;
  return now - lastAppliedAt >= PROGRESS_RENDER_INTERVAL_MS || Math.abs(percent - previous) >= PROGRESS_RENDER_STEP_PERCENT || percent >= 100;
}
