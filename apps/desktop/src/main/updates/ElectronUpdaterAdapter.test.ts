import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, mock } from "bun:test";

const updaterMock = {
  instances: [] as Array<{
    className: string;
    writes: string[];
    target: Record<string, unknown>;
    emit(event: string, ...args: unknown[]): boolean;
    listenerCount(event: string): number;
  }>,
  tokens: [] as Array<{ cancelled: boolean }>,
  checkResult: null as unknown,
  downloadArgs: [] as unknown[],
  installCalls: [] as Array<[boolean, boolean]>,
  installError: null as Error | null
};

mock.module("electron-updater", () => {
  class CancellationToken {
    cancelled = false;
    constructor() {
      updaterMock.tokens.push(this);
    }
    cancel(): void {
      this.cancelled = true;
    }
  }

  class FakeUpdater extends EventEmitter {
    writes: string[] = [];
    allowDowngrade = false;
    private channelValue: string | null = null;

    constructor() {
      super();
      const writes = this.writes;
      const proxy = new Proxy(this, {
        set(target, property, value) {
          if (!String(property).startsWith("_")) {
            writes.push(`${String(property)}=${typeof value === "object" && value !== null ? "object" : String(value)}`);
          }
          return Reflect.set(target, property, value, target);
        }
      });
      updaterMock.instances.push({
        className: new.target.name,
        writes,
        target: this as unknown as Record<string, unknown>,
        emit: (event, ...args) => this.emit(event, ...args),
        listenerCount: (event) => this.listenerCount(event)
      });
      return proxy;
    }

    get channel(): string | null {
      return this.channelValue;
    }

    set channel(value: string | null) {
      this.channelValue = value;
      this.allowDowngrade = true;
    }

    async checkForUpdates(): Promise<unknown> {
      return updaterMock.checkResult;
    }

    async downloadUpdate(token: unknown): Promise<string[]> {
      updaterMock.downloadArgs.push(token);
      return ["C:/cache/installer.exe"];
    }

    quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void {
      updaterMock.installCalls.push([isSilent, isForceRunAfter]);
      if (updaterMock.installError) this.emit("error", updaterMock.installError);
    }
  }

  class NsisUpdater extends FakeUpdater {}
  class AppImageUpdater extends FakeUpdater {}
  class DebUpdater extends FakeUpdater {}

  return { CancellationToken, NsisUpdater, AppImageUpdater, DebUpdater };
});

import type { UpdaterKind } from "./UpdateService.js";

const { downloadedInfo, ElectronUpdaterAdapter, STAGING_ID_PLACEHOLDER } = await import("./ElectronUpdaterAdapter.js");

function create(kind: UpdaterKind = "nsis"): { adapter: InstanceType<typeof ElectronUpdaterAdapter>; logs: string[]; instance: (typeof updaterMock.instances)[number] } {
  const logs: string[] = [];
  const adapter = new ElectronUpdaterAdapter({
    kind,
    homeDir: "C:\\Users\\Jane",
    sink: { info: (message) => logs.push(`info ${message}`), warn: (message) => logs.push(`warn ${message}`) }
  });
  const instance = updaterMock.instances[updaterMock.instances.length - 1];
  return { adapter, logs, instance };
}

describe("ElectronUpdaterAdapter", () => {
  beforeEach(() => {
    updaterMock.instances.length = 0;
    updaterMock.tokens.length = 0;
    updaterMock.downloadArgs.length = 0;
    updaterMock.checkResult = null;
    updaterMock.installCalls.length = 0;
    updaterMock.installError = null;
  });

  it("forbids downgrades after the channel setter re-enables them", () => {
    const { adapter, instance } = create();
    adapter.configure({ channel: "alpha" });
    const channelIndex = instance.writes.indexOf("channel=alpha");
    const downgradeIndex = instance.writes.lastIndexOf("allowDowngrade=false");
    expect(channelIndex).toBeGreaterThanOrEqual(0);
    expect(downgradeIndex).toBeGreaterThan(channelIndex);
    expect(instance.target.allowDowngrade).toBe(false);
  });

  it("applies the alpha and stable policies without touching signature verification", () => {
    const { adapter, instance } = create();
    adapter.configure({ channel: "alpha" });
    expect(instance.target).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: true,
      channel: "alpha",
      allowDowngrade: false,
      forceDevUpdateConfig: false,
      fullChangelog: false,
      disableWebInstaller: true,
      requestHeaders: { "x-user-staging-id": STAGING_ID_PLACEHOLDER }
    });
    adapter.configure({ channel: "stable" });
    expect(instance.target).toMatchObject({ allowPrerelease: false, channel: "latest", allowDowngrade: false });
    const touched = new Set(instance.writes.map((write) => write.split("=")[0]));
    expect([...touched].sort()).toEqual(
      [
        "allowDowngrade",
        "allowPrerelease",
        "autoDownload",
        "autoInstallOnAppQuit",
        "channel",
        "disableWebInstaller",
        "forceDevUpdateConfig",
        "fullChangelog",
        "logger",
        "requestHeaders"
      ].sort()
    );
  });

  it("builds the updater class that matches the package kind", () => {
    expect(create("nsis").instance.className).toBe("NsisUpdater");
    expect(create("appimage").instance.className).toBe("AppImageUpdater");
    expect(create("deb").instance.className).toBe("DebUpdater");
  });

  it("disables the web installer only for nsis and applies the same policy to every kind", () => {
    const nsis = create("nsis");
    nsis.adapter.configure({ channel: "alpha" });
    expect(nsis.instance.target.disableWebInstaller).toBe(true);
    for (const kind of ["appimage", "deb"] as const) {
      const { adapter, instance } = create(kind);
      adapter.configure({ channel: "alpha" });
      expect(instance.writes).not.toContain("disableWebInstaller=true");
      expect(instance.target).toMatchObject({
        autoDownload: false,
        autoInstallOnAppQuit: false,
        allowPrerelease: true,
        channel: "alpha",
        allowDowngrade: false,
        requestHeaders: { "x-user-staging-id": STAGING_ID_PLACEHOLDER }
      });
    }
  });

  it("routes library logs through the redactor", () => {
    const { adapter, instance, logs } = create();
    adapter.configure({ channel: "stable" });
    const logger = instance.target.logger as { info(message: unknown): void; error(message: unknown): void };
    logger.info("Downloading https://github.com/o/r/releases/download/v1/a.exe?token=secret to C:\\Users\\Jane\\AppData");
    logger.error(new Error("boom"));
    expect(logs[0]).toBe("info electron-updater: Downloading https://github.com/o/r/releases/download/v1/a.exe to ~\\AppData");
    expect(logs[1]).toMatch(/^warn electron-updater: Error: boom/);
  });

  it("maps check results and reports an inactive updater as null", async () => {
    const { adapter } = create();
    expect(await adapter.check()).toBeNull();
    updaterMock.checkResult = {
      isUpdateAvailable: true,
      updateInfo: { version: "1.1.0", releaseName: "cw-code 1.1.0", releaseNotes: [{ version: "1.1.0", note: "x" }], releaseDate: "2026-09-24", files: [] }
    };
    expect(await adapter.check()).toEqual({
      available: true,
      info: { version: "1.1.0", releaseName: "cw-code 1.1.0", releaseNotes: [{ version: "1.1.0", note: "x" }], releaseDate: "2026-09-24" }
    });
  });

  it("downloads with a cancellation token the handle can cancel", async () => {
    const { adapter } = create();
    const handle = adapter.download();
    expect(updaterMock.downloadArgs[0]).toBe(updaterMock.tokens[0]);
    handle.cancel();
    expect(updaterMock.tokens[0].cancelled).toBe(true);
    await expect(handle.done).resolves.toBeUndefined();
  });

  it("never installs on an ordinary quit: every configure keeps autoInstallOnAppQuit off", () => {
    const { adapter, instance } = create();
    for (const channel of ["alpha", "stable", "alpha"] as const) {
      adapter.configure({ channel });
      expect(instance.target.autoInstallOnAppQuit).toBe(false);
      expect(instance.target.autoDownload).toBe(false);
    }
    expect(updaterMock.installCalls).toEqual([]);
  });

  it("passes the install flags through and throws when the library reports a synchronous install failure", () => {
    const { adapter, instance } = create();
    adapter.quitAndInstall(true, true);
    expect(updaterMock.installCalls).toEqual([[true, true]]);
    updaterMock.installError = new Error("No update filepath provided, can't quit and install");
    expect(() => adapter.quitAndInstall(true, true)).toThrow("No update filepath provided");
    expect(instance.listenerCount("error")).toBe(1);
  });

  it("reports the cached installer path and the size of the matching feed file", () => {
    const file = "C:\\Users\\Jane\\AppData\\Local\\@cw-codedesktop-updater\\pending\\cw-code-Setup-1.1.0-x64.exe";
    const files = [
      { url: "cw-code-Setup-1.1.0-x64.exe.blockmap", size: 9, sha512: "b" },
      { url: "cw-code-Setup-1.1.0-x64.exe", size: 1234, sha512: "a" }
    ];
    expect(downloadedInfo({ version: "1.1.0", downloadedFile: file, files, path: "", sha512: "", releaseDate: "" })).toEqual({
      version: "1.1.0",
      file,
      size: 1234
    });
    expect(
      downloadedInfo({ version: "1.1.0", downloadedFile: file, files: [{ url: "https://x/other%20name.exe", size: 7, sha512: "a" }], path: "", sha512: "", releaseDate: "" })
    ).toEqual({ version: "1.1.0", file, size: 7 });
    expect(downloadedInfo({ version: "1.1.0", downloadedFile: "", files: [], path: "", sha512: "", releaseDate: "" })).toEqual({
      version: "1.1.0",
      file: null,
      size: null
    });
  });

  it("matches the size of the downloaded feed file for a POSIX cache path", () => {
    const file = "/home/jane/.cache/@cw-codedesktop-updater/pending/cw-code-1.1.0-x86_64.AppImage";
    const files = [
      { url: "cw-code-1.1.0-x86_64.AppImage.blockmap", size: 9, sha512: "b" },
      { url: "cw-code-1.1.0-x86_64.AppImage", size: 5678, sha512: "a" }
    ];
    expect(downloadedInfo({ version: "1.1.0", downloadedFile: file, files, path: "", sha512: "", releaseDate: "" })).toEqual({
      version: "1.1.0",
      file,
      size: 5678
    });
  });

  it("keeps an error listener installed and forwards events until disposed", () => {
    const { adapter, instance } = create();
    expect(instance.listenerCount("error")).toBe(1);
    const errors: string[] = [];
    const progress: number[] = [];
    const downloaded: string[] = [];
    adapter.onError((error) => errors.push(error.message));
    adapter.onProgress((info) => progress.push(info.percent));
    adapter.onDownloaded((info) => downloaded.push(info.version));
    instance.emit("error", new Error("offline"));
    instance.emit("download-progress", { percent: 50, transferred: 5, total: 10, bytesPerSecond: 1, delta: 1 });
    instance.emit("update-downloaded", { version: "1.1.0", downloadedFile: "x" });
    expect(errors).toEqual(["offline"]);
    expect(progress).toEqual([50]);
    expect(downloaded).toEqual(["1.1.0"]);
    adapter.dispose();
    expect(instance.listenerCount("download-progress")).toBe(0);
    expect(instance.listenerCount("update-downloaded")).toBe(0);
    expect(instance.listenerCount("error")).toBe(1);
    expect(() => instance.emit("error", new Error("late"))).not.toThrow();
    expect(errors).toEqual(["offline"]);
  });
});
