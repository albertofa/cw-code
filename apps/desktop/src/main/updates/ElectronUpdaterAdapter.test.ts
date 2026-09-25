import { beforeEach, describe, expect, it, vi } from "vitest";

const updaterMock = vi.hoisted(() => ({
  instances: [] as Array<{
    writes: string[];
    target: Record<string, unknown>;
    emit(event: string, ...args: unknown[]): boolean;
    listenerCount(event: string): number;
  }>,
  tokens: [] as Array<{ cancelled: boolean }>,
  checkResult: null as unknown,
  downloadArgs: [] as unknown[]
}));

vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");

  class CancellationToken {
    cancelled = false;
    constructor() {
      updaterMock.tokens.push(this);
    }
    cancel(): void {
      this.cancelled = true;
    }
  }

  class NsisUpdater extends EventEmitter {
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

    quitAndInstall(): void {}
  }

  return { CancellationToken, NsisUpdater };
});

import { ElectronUpdaterAdapter, STAGING_ID_PLACEHOLDER } from "./ElectronUpdaterAdapter.js";

function create(): { adapter: ElectronUpdaterAdapter; logs: string[]; instance: (typeof updaterMock.instances)[number] } {
  const logs: string[] = [];
  const adapter = new ElectronUpdaterAdapter({
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
