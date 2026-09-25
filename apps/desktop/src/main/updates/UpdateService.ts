import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ShutdownCommitResult,
  ShutdownReason,
  UpdateActionCode,
  UpdateActionResult,
  UpdateChannel,
  UpdateProgress,
  UpdateState
} from "@cw-code/contracts";
import type { UpdaterAdapter, UpdaterCheckOutcome, UpdaterDownloadedInfo, UpdaterDownloadHandle } from "./ElectronUpdaterAdapter.js";
import { describeUpdateError, formatLogValue, isMissingReleaseError, redactUpdateText, updateErrorCode, type UpdateLogSink } from "./updateLog.js";
import {
  boundedText,
  channelOfVersion,
  initialUpdateState,
  isEligible,
  isUpdateChannel,
  normalizeReleaseNotes,
  reduceUpdate,
  type UpdateCandidate,
  type UpdateEvent,
  type UpdateFailure
} from "./updateState.js";

export const FIRST_CHECK_DELAY_MS = 45_000;
export const FIRST_CHECK_JITTER_MS = 15_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const CHECK_INTERVAL_JITTER = 0.1;
export const BACKOFF_BASE_MS = 5 * 60 * 1000;
export const BACKOFF_MAX_MS = CHECK_INTERVAL_MS;

export const DISABLED_IN_DEVELOPMENT = "Updates are disabled in development builds";
export const DISABLED_WITHOUT_FEED = "No update feed is configured for this build";
export const DISABLED_WITHOUT_INSTALLER = "This copy of cw-code was not installed with the Windows installer";
export const UPDATE_CONFIG_FILE_NAME = "app-update.yml";

const UNINSTALLER_RE = /^Uninstall .+\.exe$/i;
const PROGRESS_MILESTONES = [25, 50, 75, 100];
const RELEASE_NAME_MAX_CHARS = 200;
const RELEASE_DATE_MAX_CHARS = 64;
const INSTALL_VERSION_MAX_CHARS = 64;
const INSTALL_ERROR_MAX_CHARS = 300;
export const SUSPENDED_CHECK_RETRY_MS = 60_000;
export const INSTALLER_MISSING_MESSAGE = "The downloaded update is missing; download it again";
export const INSTALLER_STARTED_MESSAGE = "The installer was started; restart cw-code if it is still open";

export interface UpdateEnvironment {
  isPackaged: boolean;
  resourcesPath: string;
  execPath: string;
}

export interface UpdateScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface UpdateFileChecks {
  fileExists(path: string): boolean;
  listDirectory(path: string): string[];
}

export interface UpdateServiceOptions {
  runningVersion: string;
  channel?: UpdateChannel;
  autoDownload?: boolean;
  environment: UpdateEnvironment;
  files: UpdateFileChecks;
  createAdapter: () => UpdaterAdapter;
  logger: UpdateLogSink;
  homeDir: string;
  scheduler?: UpdateScheduler;
  now?: () => number;
  random?: () => number;
  canRunScheduledCheck?: () => boolean;
  inspectFile?: (path: string) => InstallerFileFacts | null;
}

export interface InstallerFileFacts {
  isFile: boolean;
  size: number;
}

function inspectFileOnDisk(path: string): InstallerFileFacts | null {
  try {
    const stats = statSync(path);
    return { isFile: stats.isFile(), size: stats.size };
  } catch {
    return null;
  }
}

interface ActiveDownload {
  op: number;
  version: string;
  handle: UpdaterDownloadHandle;
  milestones: Set<number>;
}

type CheckTrigger = "manual" | "scheduled" | "channel" | "startup";

type UpdateActionFailure = Extract<UpdateActionResult, { ok: false }>;

export interface UpdateInstallSession {
  reason(): ShutdownReason | null;
  commit(action: () => void): Promise<ShutdownCommitResult>;
  release(): void;
}

interface InstallTarget {
  version: string;
  channel: UpdateChannel;
}

function parseInstallTarget(request: unknown): InstallTarget | null {
  if (!request || typeof request !== "object") return null;
  const { version, channel } = request as { version?: unknown; channel?: unknown };
  if (typeof version !== "string" || version.length === 0 || version.length > INSTALL_VERSION_MAX_CHARS) return null;
  if (!isUpdateChannel(channel)) return null;
  return { version, channel };
}

function hasUninstaller(files: UpdateFileChecks, directory: string): boolean {
  try {
    return files.listDirectory(directory).some((name) => UNINSTALLER_RE.test(name));
  } catch {
    return false;
  }
}

export function detectDisabledReason(environment: UpdateEnvironment, files: UpdateFileChecks): string | null {
  if (!environment.isPackaged) return DISABLED_IN_DEVELOPMENT;
  if (!files.fileExists(join(environment.resourcesPath, UPDATE_CONFIG_FILE_NAME))) return DISABLED_WITHOUT_FEED;
  if (!hasUninstaller(files, dirname(environment.execPath))) return DISABLED_WITHOUT_INSTALLER;
  return null;
}

export const timerScheduler: UpdateScheduler = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return () => clearTimeout(handle);
  }
};

export class UpdateService {
  private state: UpdateState;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private readonly inflight = new Map<string, Promise<UpdateActionResult>>();
  private pendingChannel: { channel: UpdateChannel; promise: Promise<UpdateActionResult> } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private adapter: UpdaterAdapter | null = null;
  private adapterDetachers: Array<() => void> = [];
  private activeDownload: ActiveDownload | null = null;
  private opCounter = 0;
  private consecutiveFailures = 0;
  private cancelScheduled: (() => void) | null = null;
  private started = false;
  private installerStarted = false;
  private installer: UpdaterDownloadedInfo | null = null;
  private disposed = false;
  private readonly scheduler: UpdateScheduler;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: UpdateServiceOptions) {
    this.scheduler = options.scheduler ?? timerScheduler;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    const disabledReason = detectDisabledReason(options.environment, options.files);
    this.state = initialUpdateState({
      runningVersion: options.runningVersion,
      channel: options.channel ?? channelOfVersion(options.runningVersion),
      autoDownload: options.autoDownload ?? false,
      disabledReason
    });
    if (disabledReason) this.log("info", `updates disabled: ${disabledReason}`);
  }

  getState(): UpdateState {
    return this.state;
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.started || this.disposed || this.state.phase === "disabled") return;
    this.started = true;
    this.scheduleCheck(FIRST_CHECK_DELAY_MS + this.jitter(FIRST_CHECK_JITTER_MS), "startup");
  }

  check(): Promise<UpdateActionResult> {
    return this.requestCheck("manual");
  }

  download(): Promise<UpdateActionResult> {
    const blocked = this.blockedResult();
    if (blocked) return Promise.resolve(blocked);
    return this.dedupe("download", () => this.enqueue(() => this.performDownload()));
  }

  setChannel(channel: unknown): Promise<UpdateActionResult> {
    if (!isUpdateChannel(channel)) {
      return Promise.resolve(this.fail("invalid", "The update channel must be 'stable' or 'alpha'"));
    }
    const blocked = this.blockedResult();
    if (blocked) return Promise.resolve(blocked);
    if (this.state.phase === "installing" || this.inflight.has("install")) {
      return Promise.resolve(this.fail("busy", "cw-code is restarting to install an update"));
    }
    if (this.pendingChannel?.channel === channel) return this.pendingChannel.promise;
    if (!this.pendingChannel && channel === this.state.channel) return Promise.resolve(this.ok());
    const active = this.activeDownload;
    if (active && !isEligible(active.version, this.state.runningVersion, channel)) {
      try {
        this.adapter?.configure({ channel });
      } catch (error) {
        return Promise.resolve(this.fail("failed", describeUpdateError(error, this.options.homeDir).message));
      }
      this.cancelActiveDownload(`update channel changed to ${channel}`);
    }
    this.inflight.delete("download");
    const promise = this.enqueue(() => this.applyChannel(channel)).finally(() => {
      if (this.pendingChannel?.promise === promise) this.pendingChannel = null;
    });
    this.pendingChannel = { channel, promise };
    return promise;
  }

  install(request: unknown, session: UpdateInstallSession): Promise<UpdateActionResult> {
    if (session.reason() !== "update") {
      return Promise.resolve(this.fail("invalid", "This restart request was not prepared for an update"));
    }
    const blocked = this.blockedResult();
    if (blocked) {
      session.release();
      return Promise.resolve(blocked);
    }
    const target = parseInstallTarget(request);
    if (!target) {
      session.release();
      return Promise.resolve(this.fail("invalid", "An install request needs the downloaded version and its channel"));
    }
    if (this.inflight.has("install")) return Promise.resolve(this.fail("busy", "An update is already being installed"));
    return this.dedupe("install", () => this.enqueue(() => this.performInstall(target, session)));
  }

  setAutoDownload(autoDownload: boolean): UpdateActionResult {
    this.dispatch({ type: "auto-download-changed", autoDownload });
    if (autoDownload && this.state.phase === "available") void this.download();
    return this.ok();
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.state.phase === "installing") {
      this.log("info", "keeping the updater alive while the installer takes over, in case cw-code does not exit");
      return;
    }
    this.disposed = true;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.cancelActiveDownload("updater disposed");
    for (const detach of this.adapterDetachers.splice(0)) detach();
    this.adapter?.dispose();
    this.adapter = null;
    this.listeners.clear();
    this.inflight.clear();
    this.pendingChannel = null;
  }

  private requestCheck(trigger: CheckTrigger): Promise<UpdateActionResult> {
    const blocked = this.blockedResult();
    if (blocked) return Promise.resolve(blocked);
    const running = this.inflight.get("check");
    if (running) return running;
    if (this.activeDownload || this.inflight.has("download")) {
      return Promise.resolve(this.fail("busy", "An update is downloading; check again after it finishes"));
    }
    return this.queueCheck(trigger);
  }

  private queueCheck(trigger: CheckTrigger): Promise<UpdateActionResult> {
    return this.dedupe("check", () => this.enqueue(() => this.performCheck(trigger)));
  }

  private async performCheck(trigger: CheckTrigger): Promise<UpdateActionResult> {
    if (this.disposed) return this.fail("superseded", "The updater shut down before the check started");
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.dispatch({ type: "check-started" });
    this.log("info", `check started (${trigger}, channel ${this.state.channel}, running ${this.state.runningVersion})`);
    let outcome: UpdaterCheckOutcome | null;
    try {
      outcome = await this.ensureAdapter().check();
    } catch (error) {
      if (this.disposed) return this.fail("superseded", "The updater shut down during the check");
      if (this.state.channel === "stable" && isMissingReleaseError(error)) {
        this.log("warn", `no stable release yet (${updateErrorCode(error)})`);
        return this.checkSucceeded(null);
      }
      return this.checkFailed(describeUpdateError(error, this.options.homeDir));
    }
    if (this.disposed) return this.fail("superseded", "The updater shut down during the check");
    if (!outcome) return this.checkFailed({ message: "The updater is not active in this build", retryable: false });
    const candidate = this.candidateFrom(outcome);
    this.log("info", candidate ? `update ${candidate.version} is available` : "no eligible update found");
    return this.checkSucceeded(candidate);
  }

  private checkSucceeded(candidate: UpdateCandidate | null): UpdateActionResult {
    this.consecutiveFailures = 0;
    this.dispatch({ type: "check-succeeded", at: this.now(), candidate });
    this.scheduleCheck(this.intervalDelay(), "scheduled");
    if (this.state.autoDownload && this.state.phase === "available") void this.download();
    return this.ok();
  }

  private checkFailed(failure: UpdateFailure): UpdateActionResult {
    this.consecutiveFailures += 1;
    this.dispatch({ type: "check-failed", at: this.now(), failure });
    const delay = this.backoffDelay();
    this.log("warn", `check failed (${failure.retryable ? "retryable" : "not retryable"}; next check in ${Math.round(delay / 1000)}s): ${failure.message}`);
    this.scheduleCheck(delay, "scheduled");
    return this.fail("failed", failure.message);
  }

  private candidateFrom(outcome: UpdaterCheckOutcome): UpdateCandidate | null {
    if (!outcome.available) return null;
    const { version } = outcome.info;
    if (!isEligible(version, this.state.runningVersion, this.state.channel)) {
      this.log("warn", `ignoring version ${JSON.stringify(String(version).slice(0, 64))}: not eligible on the ${this.state.channel} channel`);
      return null;
    }
    return {
      version,
      releaseName: boundedText(outcome.info.releaseName, RELEASE_NAME_MAX_CHARS),
      releaseNotes: normalizeReleaseNotes(outcome.info.releaseNotes),
      releaseDate: boundedText(outcome.info.releaseDate, RELEASE_DATE_MAX_CHARS)
    };
  }

  private async performDownload(): Promise<UpdateActionResult> {
    if (this.disposed) return this.fail("superseded", "The updater shut down before the download started");
    const { availableVersion, downloadedVersion, phase, error, runningVersion } = this.state;
    if (availableVersion !== null && availableVersion === downloadedVersion) return this.ok();
    if (availableVersion === null) return this.fail("no-update", "No update is available to download");
    const targetChannel = this.pendingChannel?.channel ?? this.state.channel;
    if (!isEligible(availableVersion, runningVersion, targetChannel)) {
      return this.fail("superseded", "The update channel changed before the download started");
    }
    if (phase !== "available" && error?.context !== "download") {
      return this.fail("not-ready", "Check for updates before downloading");
    }
    const op = ++this.opCounter;
    this.installer = null;
    this.dispatch({ type: "download-started", version: availableVersion });
    let handle: UpdaterDownloadHandle;
    try {
      handle = this.ensureAdapter().download();
    } catch (err) {
      return this.downloadFailed(describeUpdateError(err, this.options.homeDir));
    }
    this.activeDownload = { op, version: availableVersion, handle, milestones: new Set() };
    this.log("info", `download started for ${availableVersion}`);
    try {
      await handle.done;
    } catch (err) {
      if (this.activeDownload?.op !== op || this.disposed) {
        return this.fail("superseded", "The download was cancelled because the update channel changed");
      }
      this.activeDownload = null;
      return this.downloadFailed(describeUpdateError(err, this.options.homeDir));
    }
    if (this.activeDownload?.op !== op || this.disposed) {
      return this.fail("superseded", "The download finished after the update channel changed and was discarded");
    }
    this.activeDownload = null;
    this.dispatch({ type: "download-succeeded", version: availableVersion });
    this.log("info", `download verified for ${availableVersion}`);
    return this.ok();
  }

  private downloadFailed(failure: UpdateFailure): UpdateActionResult {
    this.dispatch({ type: "download-failed", failure });
    this.log("warn", `download failed (${failure.retryable ? "retryable" : "not retryable"}): ${failure.message}`);
    return this.fail("failed", failure.message);
  }

  private async performInstall(target: InstallTarget, session: UpdateInstallSession): Promise<UpdateActionResult> {
    const rejection = this.installRejection(target);
    if (rejection) {
      session.release();
      this.log("info", `install of ${target.version} rejected: ${rejection.message}`);
      return rejection;
    }
    const missing = this.installerProblem(target.version);
    if (missing) {
      session.release();
      this.dispatch({ type: "installer-missing", failure: { message: INSTALLER_MISSING_MESSAGE, retryable: true } });
      this.log("warn", `install of ${target.version} refused: ${missing}`);
      return this.fail("not-ready", INSTALLER_MISSING_MESSAGE);
    }
    this.dispatch({ type: "install-started", version: target.version });
    this.log("info", `installing ${target.version} through the shutdown coordinator`);
    let invoked = false;
    let committed: ShutdownCommitResult;
    try {
      committed = await session.commit(() => {
        this.ensureAdapter().quitAndInstall(true, true);
        invoked = true;
      });
    } catch (error) {
      committed = { ok: false, message: describeUpdateError(error, this.options.homeDir).message };
    }
    if (committed.ok) return this.ok();
    if (invoked) this.installerStarted = true;
    const failure: UpdateFailure = invoked
      ? { message: INSTALLER_STARTED_MESSAGE, retryable: false }
      : {
          message: boundedText(redactUpdateText(committed.message, this.options.homeDir), INSTALL_ERROR_MAX_CHARS) ?? "The installer could not be started",
          retryable: true
        };
    this.dispatch({ type: "install-failed", failure });
    this.log("warn", `install of ${target.version} failed: ${failure.message}`);
    return this.fail("failed", failure.message);
  }

  private installerProblem(version: string): string | null {
    const installer = this.installer;
    if (!installer || installer.version !== version) return `no downloaded installer was reported for ${version}`;
    if (!installer.file) return "the updater did not report where the installer was saved";
    const facts = (this.options.inspectFile ?? inspectFileOnDisk)(installer.file);
    if (!facts) return `the installer ${installer.file} does not exist`;
    if (!facts.isFile) return `the installer ${installer.file} is not a regular file`;
    if (installer.size !== null && facts.size !== installer.size) {
      return `the installer ${installer.file} has ${facts.size} bytes, expected ${installer.size}`;
    }
    return null;
  }

  private installRejection(target: InstallTarget): UpdateActionFailure | null {
    if (this.disposed) return this.fail("superseded", "The updater shut down before the install started");
    const { phase, downloadedVersion, availableVersion, channel } = this.state;
    if (downloadedVersion === null) return this.fail("not-ready", "The update has not been downloaded yet");
    if (downloadedVersion !== target.version) {
      return this.fail("superseded", `Version ${target.version} is no longer the downloaded update`);
    }
    const targetChannel = this.pendingChannel?.channel ?? channel;
    if (targetChannel !== target.channel) return this.fail("superseded", `The update channel changed to ${targetChannel}`);
    if (phase === "available") {
      return this.fail("superseded", `A newer version (${availableVersion ?? "unknown"}) was found; download it before restarting`);
    }
    if (phase !== "ready") return this.fail("not-ready", `The update is not ready to install (${phase})`);
    return null;
  }

  private async applyChannel(channel: UpdateChannel): Promise<UpdateActionResult> {
    if (this.disposed) return this.fail("superseded", "The updater shut down before the channel changed");
    if (channel === this.state.channel) return this.ok();
    try {
      this.adapter?.configure({ channel });
    } catch (error) {
      return this.fail("failed", describeUpdateError(error, this.options.homeDir).message);
    }
    this.dispatch({ type: "channel-changed", channel });
    this.log("info", `channel changed to ${channel}`);
    void this.queueCheck("channel");
    return this.ok();
  }

  private handleProgress(progress: UpdateProgress): void {
    const active = this.activeDownload;
    if (!active) return;
    this.dispatch({ type: "download-progress", progress });
    const percent = this.state.progress?.percent ?? 0;
    for (const milestone of PROGRESS_MILESTONES) {
      if (percent >= milestone && !active.milestones.has(milestone)) {
        active.milestones.add(milestone);
        this.log("info", `download ${active.version} reached ${milestone}%`);
      }
    }
  }

  private ensureAdapter(): UpdaterAdapter {
    if (this.adapter) return this.adapter;
    const adapter = this.options.createAdapter();
    adapter.configure({ channel: this.state.channel });
    this.adapterDetachers = [
      adapter.onProgress((progress) => this.handleProgress(progress)),
      adapter.onError((error) => this.log("warn", `updater error: ${formatLogValue(error)}`)),
      adapter.onDownloaded((info) => {
        this.installer = info;
        this.log("info", `updater cached installer for ${String(info.version).slice(0, 64)}`);
      })
    ];
    this.adapter = adapter;
    return adapter;
  }

  private cancelActiveDownload(reason: string): void {
    const active = this.activeDownload;
    if (!active) return;
    this.activeDownload = null;
    this.log("info", `cancelling download of ${active.version}: ${reason}`);
    try {
      active.handle.cancel();
    } catch (error) {
      this.log("warn", `download cancel failed: ${formatLogValue(error)}`);
    }
  }

  private scheduleCheck(delayMs: number, trigger: CheckTrigger): void {
    if (!this.started || this.disposed) return;
    this.cancelScheduled?.();
    this.cancelScheduled = this.scheduler.schedule(() => {
      this.cancelScheduled = null;
      if (this.options.canRunScheduledCheck && !this.options.canRunScheduledCheck()) {
        this.log("info", `scheduled check postponed while cw-code is preparing to restart`);
        this.scheduleCheck(SUSPENDED_CHECK_RETRY_MS, trigger);
        return;
      }
      void this.requestCheck(trigger).then((result) => {
        if (!result.ok && (result.code === "busy" || result.code === "superseded")) {
          this.scheduleCheck(this.intervalDelay(), "scheduled");
        }
      });
    }, Math.max(0, Math.round(delayMs)));
  }

  private intervalDelay(): number {
    return CHECK_INTERVAL_MS + this.jitter(CHECK_INTERVAL_MS * CHECK_INTERVAL_JITTER);
  }

  private backoffDelay(): number {
    const exponent = Math.min(Math.max(this.consecutiveFailures - 1, 0), 30);
    const base = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
    return Math.min(base + this.jitter(base * CHECK_INTERVAL_JITTER), BACKOFF_MAX_MS);
  }

  private jitter(spread: number): number {
    return (this.random() * 2 - 1) * spread;
  }

  private dedupe(key: string, factory: () => Promise<UpdateActionResult>): Promise<UpdateActionResult> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise: Promise<UpdateActionResult> = factory().finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private enqueue(operation: () => Promise<UpdateActionResult>): Promise<UpdateActionResult> {
    const result = this.tail.then(operation).catch((error: unknown) => this.operationCrashed(error));
    this.tail = result;
    return result;
  }

  private operationCrashed(error: unknown): UpdateActionResult {
    const failure = describeUpdateError(error, this.options.homeDir);
    this.log("warn", `update operation failed unexpectedly: ${failure.message}`);
    if (!this.disposed) {
      this.consecutiveFailures += 1;
      this.cancelActiveDownload("update operation failed unexpectedly");
      this.dispatch({ type: "check-failed", at: this.now(), failure });
      this.dispatch({ type: "download-failed", failure });
      if (!this.cancelScheduled) this.scheduleCheck(this.backoffDelay(), "scheduled");
    }
    return this.fail("failed", failure.message);
  }

  private dispatch(event: UpdateEvent): void {
    const next = reduceUpdate(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (error) {
        this.log("warn", `update listener failed: ${formatLogValue(error)}`);
      }
    }
  }

  private blockedResult(): UpdateActionResult | null {
    if (this.disposed) return this.fail("disabled", "The updater has shut down");
    if (this.installerStarted) return this.fail("failed", INSTALLER_STARTED_MESSAGE);
    if (this.state.phase === "disabled") {
      return this.fail("disabled", this.state.disabledReason ?? DISABLED_IN_DEVELOPMENT);
    }
    return null;
  }

  private ok(): UpdateActionResult {
    return { ok: true, state: this.state };
  }

  private fail(code: UpdateActionCode, message: string): UpdateActionFailure {
    return { ok: false, code, message, state: this.state };
  }

  private log(level: "info" | "warn", message: string): void {
    this.options.logger[level](redactUpdateText(message, this.options.homeDir));
  }
}
