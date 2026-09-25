import { CancellationToken, NsisUpdater, type Logger, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from "electron-updater";
import type { UpdateChannel, UpdateProgress } from "@cw-code/contracts";
import { formatLogValue, redactUpdateText, type UpdateLogSink } from "./updateLog.js";

export const STAGING_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

export interface UpdaterReleaseInfo {
  version: string;
  releaseName: string | null;
  releaseNotes: unknown;
  releaseDate: string | null;
}

export interface UpdaterCheckOutcome {
  available: boolean;
  info: UpdaterReleaseInfo;
}

export interface UpdaterDownloadHandle {
  done: Promise<void>;
  cancel(): void;
}

export interface UpdaterAdapter {
  configure(options: { channel: UpdateChannel }): void;
  check(): Promise<UpdaterCheckOutcome | null>;
  download(): UpdaterDownloadHandle;
  onProgress(listener: (progress: UpdateProgress) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onDownloaded(listener: (info: { version: string }) => void): () => void;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  dispose(): void;
}

function releaseInfo(info: UpdateInfo): UpdaterReleaseInfo {
  return {
    version: info.version,
    releaseName: info.releaseName ?? null,
    releaseNotes: info.releaseNotes ?? null,
    releaseDate: info.releaseDate ?? null
  };
}

export class ElectronUpdaterAdapter implements UpdaterAdapter {
  private readonly updater: NsisUpdater;
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly detachers: Array<() => void> = [];
  private readonly logger: Logger;

  constructor(options: { homeDir: string; sink: UpdateLogSink }) {
    const write = (level: "info" | "warn", message: unknown): void => {
      options.sink[level](`electron-updater: ${redactUpdateText(formatLogValue(message), options.homeDir)}`);
    };
    this.logger = {
      info: (message?: unknown) => write("info", message),
      warn: (message?: unknown) => write("warn", message),
      error: (message?: unknown) => write("warn", message)
    };
    this.updater = new NsisUpdater();
    this.updater.on("error", (error: Error) => {
      for (const listener of this.errorListeners) listener(error);
    });
  }

  configure(options: { channel: UpdateChannel }): void {
    const alpha = options.channel === "alpha";
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = alpha;
    this.updater.channel = alpha ? "alpha" : "latest";
    this.updater.allowDowngrade = false;
    this.updater.forceDevUpdateConfig = false;
    this.updater.fullChangelog = false;
    this.updater.disableWebInstaller = true;
    this.updater.requestHeaders = { "x-user-staging-id": STAGING_ID_PLACEHOLDER };
    this.updater.logger = this.logger;
  }

  async check(): Promise<UpdaterCheckOutcome | null> {
    const result = await this.updater.checkForUpdates();
    if (!result) return null;
    return { available: result.isUpdateAvailable, info: releaseInfo(result.updateInfo) };
  }

  download(): UpdaterDownloadHandle {
    const token = new CancellationToken();
    const done = this.updater.downloadUpdate(token).then(() => undefined);
    return { done, cancel: () => token.cancel() };
  }

  onProgress(listener: (progress: UpdateProgress) => void): () => void {
    const handler = (info: ProgressInfo): void =>
      listener({ percent: info.percent, transferred: info.transferred, total: info.total, bytesPerSecond: info.bytesPerSecond });
    this.updater.on("download-progress", handler);
    return this.track(() => this.updater.removeListener("download-progress", handler));
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return this.track(() => this.errorListeners.delete(listener));
  }

  onDownloaded(listener: (info: { version: string }) => void): () => void {
    const handler = (event: UpdateDownloadedEvent): void => listener({ version: event.version });
    this.updater.on("update-downloaded", handler);
    return this.track(() => this.updater.removeListener("update-downloaded", handler));
  }

  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void {
    this.updater.quitAndInstall(isSilent, isForceRunAfter);
  }

  dispose(): void {
    for (const detach of this.detachers.splice(0)) detach();
    this.errorListeners.clear();
    this.updater.logger = null;
  }

  private track(detach: () => void): () => void {
    let detached = false;
    const once = (): void => {
      if (detached) return;
      detached = true;
      detach();
    };
    this.detachers.push(once);
    return once;
  }
}
