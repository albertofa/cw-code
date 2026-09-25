import type { UpdateChannel, UpdateProgress, UpdateState } from "@cw-code/contracts";

export const RELEASE_NOTES_MAX_CHARS = 20_000;

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/;
const ALPHA_VERSION_RE = /^\d+\.\d+\.\d+-alpha/;

interface ParsedVersion {
  core: [number, number, number];
  alpha: number | null;
}

export interface UpdateCandidate {
  version: string;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
}

export interface UpdateFailure {
  message: string;
  retryable: boolean;
}

export type UpdateEvent =
  | { type: "check-started" }
  | { type: "check-succeeded"; at: number; candidate: UpdateCandidate | null }
  | { type: "check-failed"; at: number; failure: UpdateFailure }
  | { type: "download-started"; version: string }
  | { type: "download-progress"; progress: UpdateProgress }
  | { type: "download-succeeded"; version: string }
  | { type: "download-failed"; failure: UpdateFailure }
  | { type: "channel-changed"; channel: UpdateChannel }
  | { type: "auto-download-changed"; autoDownload: boolean };

function parseVersion(value: string): ParsedVersion | null {
  if (typeof value !== "string") return null;
  const match = VERSION_RE.exec(value.trim());
  if (!match) return null;
  const numbers = match.slice(1).map((part) => (part === undefined ? null : Number(part)));
  if (numbers.some((part) => part !== null && !Number.isSafeInteger(part))) return null;
  const [major, minor, patch, alpha] = numbers;
  return { core: [major ?? 0, minor ?? 0, patch ?? 0], alpha: alpha ?? null };
}

function sign(value: number): -1 | 0 | 1 {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return sign(left.core[i] - right.core[i]);
  }
  if (left.alpha === right.alpha) return 0;
  if (left.alpha === null) return 1;
  if (right.alpha === null) return -1;
  return sign(left.alpha - right.alpha);
}

export function channelOfVersion(version: string): UpdateChannel {
  return typeof version === "string" && ALPHA_VERSION_RE.test(version.trim()) ? "alpha" : "stable";
}

export function isEligible(candidate: string, running: string, channel: UpdateChannel): boolean {
  const parsed = parseVersion(candidate);
  if (!parsed) return false;
  if (channel === "stable" && parsed.alpha !== null) return false;
  return compareVersions(candidate, running) === 1;
}

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "alpha";
}

function noteEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const { version, note } = entry as { version?: unknown; note?: unknown };
  const body = typeof note === "string" ? note.trim() : "";
  if (!body) return null;
  const heading = typeof version === "string" ? version.trim() : "";
  return heading ? `## ${heading}\n\n${body}` : body;
}

export function normalizeReleaseNotes(value: unknown): string | null {
  let text: string;
  if (typeof value === "string") text = value;
  else if (Array.isArray(value)) text = value.map(noteEntry).filter((entry): entry is string => entry !== null).join("\n\n");
  else return null;
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (!normalized) return null;
  return normalized.length > RELEASE_NOTES_MAX_CHARS ? normalized.slice(0, RELEASE_NOTES_MAX_CHARS) : normalized;
}

export function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\u0000/g, "").trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

export function initialUpdateState(options: {
  runningVersion: string;
  channel: UpdateChannel;
  autoDownload: boolean;
  disabledReason: string | null;
}): UpdateState {
  return {
    seq: 0,
    phase: options.disabledReason ? "disabled" : "idle",
    runningVersion: options.runningVersion,
    channel: options.channel,
    availableVersion: null,
    downloadedVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    progress: null,
    checkedAt: null,
    error: null,
    disabledReason: options.disabledReason,
    autoDownload: options.autoDownload
  };
}

type StatePatch = Partial<Omit<UpdateState, "seq">>;

function commit(state: UpdateState, patch: StatePatch): UpdateState {
  const keys = Object.keys(patch) as Array<keyof StatePatch>;
  if (keys.every((key) => state[key] === patch[key])) return state;
  return { ...state, ...patch, seq: state.seq + 1 };
}

const NO_RELEASE: StatePatch = { availableVersion: null, releaseName: null, releaseNotes: null, releaseDate: null };

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function sanitizeProgress(progress: UpdateProgress): UpdateProgress {
  return {
    percent: Math.min(100, finite(progress.percent)),
    transferred: finite(progress.transferred),
    total: finite(progress.total),
    bytesPerSecond: finite(progress.bytesPerSecond)
  };
}

function checkSucceeded(state: UpdateState, at: number, candidate: UpdateCandidate | null): UpdateState {
  const downloaded = state.downloadedVersion;
  const coveredByDownload =
    downloaded !== null && (candidate === null || (compareVersions(candidate.version, downloaded) ?? 0) <= 0);
  if (coveredByDownload) {
    const describesDownload = state.availableVersion === downloaded;
    return commit(state, {
      phase: "ready",
      checkedAt: at,
      error: null,
      ...(describesDownload ? {} : { ...NO_RELEASE, availableVersion: downloaded })
    });
  }
  if (!candidate) return commit(state, { ...NO_RELEASE, phase: "up-to-date", checkedAt: at, error: null });
  return commit(state, {
    phase: "available",
    availableVersion: candidate.version,
    releaseName: candidate.releaseName,
    releaseNotes: candidate.releaseNotes,
    releaseDate: candidate.releaseDate,
    checkedAt: at,
    error: null
  });
}

function channelChanged(state: UpdateState, channel: UpdateChannel): UpdateState {
  if (state.channel === channel) return state;
  const keepAvailable = state.availableVersion !== null && isEligible(state.availableVersion, state.runningVersion, channel);
  const downloadedVersion =
    state.downloadedVersion !== null && isEligible(state.downloadedVersion, state.runningVersion, channel)
      ? state.downloadedVersion
      : null;
  const release: StatePatch = keepAvailable ? {} : { ...NO_RELEASE, availableVersion: downloadedVersion };
  const availableVersion = keepAvailable ? state.availableVersion : downloadedVersion;
  const phase =
    state.phase === "disabled"
      ? "disabled"
      : availableVersion !== null && availableVersion !== downloadedVersion
        ? "available"
        : downloadedVersion !== null
          ? "ready"
          : "idle";
  return commit(state, { ...release, channel, downloadedVersion, phase, progress: null, error: null });
}

export function reduceUpdate(state: UpdateState, event: UpdateEvent): UpdateState {
  if (event.type === "channel-changed") return channelChanged(state, event.channel);
  if (event.type === "auto-download-changed") return commit(state, { autoDownload: event.autoDownload });
  if (state.phase === "disabled") return state;
  switch (event.type) {
    case "check-started":
      if (state.phase === "checking" || state.phase === "downloading" || state.phase === "installing") return state;
      return commit(state, { phase: "checking", error: null });
    case "check-succeeded":
      if (state.phase !== "checking") return state;
      return checkSucceeded(state, event.at, event.candidate);
    case "check-failed":
      if (state.phase !== "checking") return state;
      return commit(state, {
        phase: state.downloadedVersion !== null ? "ready" : "error",
        checkedAt: event.at,
        error: { message: event.failure.message, context: "check", retryable: event.failure.retryable }
      });
    case "download-started":
      if (state.phase === "checking" || state.phase === "downloading" || state.phase === "installing") return state;
      if (state.availableVersion !== event.version) return state;
      return commit(state, {
        phase: "downloading",
        progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
        error: null
      });
    case "download-progress":
      if (state.phase !== "downloading") return state;
      return commit(state, { progress: sanitizeProgress(event.progress) });
    case "download-succeeded":
      if (state.phase !== "downloading" || state.availableVersion !== event.version) return state;
      return commit(state, { phase: "ready", downloadedVersion: event.version, progress: null, error: null });
    case "download-failed":
      if (state.phase !== "downloading") return state;
      return commit(state, {
        phase: state.downloadedVersion !== null ? "ready" : "error",
        progress: null,
        error: { message: event.failure.message, context: "download", retryable: event.failure.retryable }
      });
  }
}
