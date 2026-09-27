export type UpdateChannel = "stable" | "alpha";

export type UpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export type UpdateErrorContext = "check" | "download" | "install";

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateState {
  seq: number;
  phase: UpdatePhase;
  runningVersion: string;
  channel: UpdateChannel;
  availableVersion: string | null;
  downloadedVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  progress: UpdateProgress | null;
  checkedAt: number | null;
  error: { message: string; context: UpdateErrorContext; retryable: boolean } | null;
  disabledReason: string | null;
  autoDownload: boolean;
}

export type UpdateActionCode = "disabled" | "busy" | "no-update" | "not-ready" | "superseded" | "invalid" | "failed";

export type UpdateActionResult =
  | { ok: true; state: UpdateState }
  | { ok: false; code: UpdateActionCode; message: string; state: UpdateState };

export interface UpdateInstallRequest {
  version: string;
  channel: UpdateChannel;
  token: string;
}
