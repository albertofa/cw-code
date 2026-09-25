import { describe, expect, it } from "vitest";
import type { ShutdownActiveTurn, ShutdownReason, ShutdownTerminal, UpdateChannel, UpdateProgress } from "@cw-code/contracts";
import { ShutdownCoordinator, type ShutdownClock, type ShutdownPtys, type ShutdownSessions } from "../shutdown/ShutdownCoordinator.js";
import type { UpdaterAdapter, UpdaterCheckOutcome, UpdaterDownloadHandle } from "./ElectronUpdaterAdapter.js";
import {
  INSTALLER_STARTED_MESSAGE,
  SUSPENDED_CHECK_RETRY_MS,
  UpdateService,
  type UpdateInstallSession,
  type UpdateServiceOptions
} from "./UpdateService.js";

const COMMIT_EXIT_TIMEOUT_MS = 30_000;

class InstallAdapter implements UpdaterAdapter {
  checkResults: UpdaterCheckOutcome[] = [];
  installs: Array<[boolean, boolean]> = [];
  installError: Error | null = null;

  configure(): void {}

  async check(): Promise<UpdaterCheckOutcome | null> {
    return this.checkResults.shift() ?? { available: false, info: { version: "1.0.0", releaseName: null, releaseNotes: null, releaseDate: null } };
  }

  download(): UpdaterDownloadHandle {
    return { done: Promise.resolve(), cancel: () => {} };
  }

  onProgress(_listener: (progress: UpdateProgress) => void): () => void {
    return () => {};
  }

  onError(_listener: (error: Error) => void): () => void {
    return () => {};
  }

  onDownloaded(_listener: (info: { version: string }) => void): () => void {
    return () => {};
  }

  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
    if (this.installError) throw this.installError;
  }

  dispose(): void {}
}

class Sessions implements ShutdownSessions {
  calls: string[] = [];
  reserved = false;
  listShutdownTurns(): ShutdownActiveTurn[] {
    return [];
  }
  backgroundTaskCount(): number {
    return 0;
  }
  beginShutdownReservation(): void {
    this.reserved = true;
  }
  clearShutdownReservation(): void {
    this.reserved = false;
  }
  interrupt(): void {}
  cancelBackgroundWork(): void {}
  flush(): void {
    this.calls.push("flush");
  }
  async shutdownDrivers(): Promise<{ timedOut: string[] }> {
    this.calls.push("shutdownDrivers");
    return { timedOut: [] };
  }
  forceStopDrivers(): void {}
  reinitializeDrivers(): void {
    this.calls.push("reinitialize");
  }
}

class Ptys implements ShutdownPtys {
  reserved = false;
  list(): ShutdownTerminal[] {
    return [];
  }
  beginShutdownReservation(): void {
    this.reserved = true;
  }
  clearShutdownReservation(): void {
    this.reserved = false;
  }
  dispose(): void {}
  reopen(): void {}
}

class ManualClock implements ShutdownClock {
  private waiters: Array<{ ms: number; resolve: () => void }> = [];

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.waiters.push({ ms, resolve }));
  }

  fire(ms: number): void {
    for (const waiter of this.waiters.filter((entry) => entry.ms === ms)) waiter.resolve();
    this.waiters = this.waiters.filter((entry) => entry.ms !== ms);
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function available(version: string): UpdaterCheckOutcome {
  return { available: true, info: { version, releaseName: null, releaseNotes: null, releaseDate: null } };
}

function setup(overrides: Partial<UpdateServiceOptions> = {}) {
  const adapter = new InstallAdapter();
  const sessions = new Sessions();
  const ptys = new Ptys();
  const clock = new ManualClock();
  let tokens = 0;
  const coordinator = new ShutdownCoordinator({
    sessions,
    ptys,
    clock,
    createToken: () => `token-${++tokens}`,
    commitExitTimeoutMs: COMMIT_EXIT_TIMEOUT_MS,
    log: () => {}
  });
  const service = new UpdateService({
    runningVersion: "1.0.0",
    environment: { isPackaged: true, resourcesPath: "C:\\cw\\resources", execPath: "C:\\cw\\cw-code.exe" },
    files: { fileExists: () => true, listDirectory: () => ["Uninstall cw-code.exe"] },
    createAdapter: () => adapter,
    logger: { info: () => {}, warn: () => {} },
    homeDir: "C:\\Users\\Jane",
    scheduler: { schedule: () => () => {} },
    ...overrides
  });
  const released: string[] = [];
  const committed: string[] = [];
  const sessionFor = (token: string): UpdateInstallSession => ({
    reason: () => coordinator.currentReason(),
    commit: (action) => {
      committed.push(token);
      return coordinator.commit(token, action);
    },
    release: () => {
      released.push(token);
      try {
        coordinator.cancel(token);
      } catch {
      }
    }
  });
  const prepare = async (reason: ShutdownReason = "update"): Promise<string> => {
    const result = await coordinator.prepare({ reason, stopActiveTurns: true, timeoutMs: 1000 });
    if (!result.ok) throw new Error(`prepare failed: ${JSON.stringify(result)}`);
    return result.token;
  };
  const ready = async (version = "1.1.0"): Promise<void> => {
    adapter.checkResults.push(available(version));
    await service.check();
    await service.download();
  };
  return { adapter, sessions, ptys, clock, coordinator, service, released, committed, sessionFor, prepare, ready };
}

describe("UpdateService.install", () => {
  it("rejects malformed requests without committing and releases the restart request", async () => {
    const h = setup();
    await h.ready();
    const token = await h.prepare();
    for (const request of [null, "1.1.0", { channel: "stable" }, { version: "", channel: "stable" }, { version: "1.1.0", channel: "beta" }]) {
      expect(await h.service.install(request, h.sessionFor(token))).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(h.committed).toEqual([]);
    expect(h.released.length).toBeGreaterThan(0);
    expect(h.coordinator.isIdle()).toBe(true);
    expect(h.sessions.reserved).toBe(false);
  });

  it("answers not-ready before anything is downloaded", async () => {
    const h = setup();
    const token = await h.prepare();
    expect(await h.service.install({ version: "1.1.0", channel: "stable" }, h.sessionFor(token))).toMatchObject({
      ok: false,
      code: "not-ready"
    });
    expect(h.committed).toEqual([]);
    expect(h.coordinator.isIdle()).toBe(true);
  });

  it("answers superseded when the version or channel no longer match the downloaded update", async () => {
    const h = setup({ runningVersion: "1.0.0-alpha.1", channel: "alpha" });
    await h.ready("1.0.0-alpha.2");
    const cases: Array<{ version: string; channel: UpdateChannel }> = [
      { version: "1.0.0-alpha.3", channel: "alpha" },
      { version: "1.0.0-alpha.2", channel: "stable" }
    ];
    for (const request of cases) {
      const token = await h.prepare();
      expect(await h.service.install(request, h.sessionFor(token))).toMatchObject({ ok: false, code: "superseded" });
      expect(h.coordinator.isIdle()).toBe(true);
    }
    expect(h.committed).toEqual([]);
    expect(h.adapter.installs).toEqual([]);
    expect(h.service.getState()).toMatchObject({ phase: "ready", downloadedVersion: "1.0.0-alpha.2" });
  });

  it("answers superseded when a newer version was found after the download", async () => {
    const h = setup();
    await h.ready("1.1.0");
    h.adapter.checkResults.push(available("1.2.0"));
    await h.service.check();
    const token = await h.prepare();
    expect(await h.service.install({ version: "1.1.0", channel: "stable" }, h.sessionFor(token))).toMatchObject({
      ok: false,
      code: "superseded",
      state: { phase: "available", availableVersion: "1.2.0" }
    });
    expect(h.adapter.installs).toEqual([]);
  });

  it("installs through the coordinator commit with the normal installer UI and a relaunch", async () => {
    const h = setup();
    await h.ready();
    const token = await h.prepare();
    const pending = h.service.install({ version: "1.1.0", channel: "stable" }, h.sessionFor(token));
    await settle();
    expect(h.committed).toEqual([token]);
    expect(h.adapter.installs).toEqual([[false, true]]);
    expect(h.coordinator.isCommitted()).toBe(true);
    expect(h.service.getState().phase).toBe("installing");
    expect(await h.service.setChannel("alpha")).toMatchObject({ ok: false, code: "busy" });
    expect(await h.service.install({ version: "1.1.0", channel: "stable" }, h.sessionFor(token))).toMatchObject({ ok: false, code: "busy" });

    h.service.dispose();
    h.clock.fire(COMMIT_EXIT_TIMEOUT_MS);
    const result = await pending;

    expect(result).toMatchObject({ ok: false, code: "failed", message: INSTALLER_STARTED_MESSAGE });
    expect(h.service.getState()).toMatchObject({
      phase: "ready",
      downloadedVersion: "1.1.0",
      error: { context: "install", retryable: false, message: INSTALLER_STARTED_MESSAGE }
    });
    expect(h.coordinator.isIdle()).toBe(true);
    expect(h.sessions.calls).toContain("reinitialize");
    expect(h.sessions.reserved).toBe(false);
  });

  it("stays alive but refuses further installs and checks once the installer was started and cw-code did not exit", async () => {
    const h = setup();
    await h.ready();
    const pending = h.service.install({ version: "1.1.0", channel: "stable" }, h.sessionFor(await h.prepare()));
    await settle();
    h.service.dispose();
    h.clock.fire(COMMIT_EXIT_TIMEOUT_MS);
    await pending;

    const token = await h.prepare();
    expect(await h.service.install({ version: "1.1.0", channel: "stable" }, h.sessionFor(token))).toMatchObject({
      ok: false,
      code: "failed",
      message: INSTALLER_STARTED_MESSAGE
    });
    expect(h.released).toContain(token);
    expect(h.coordinator.isIdle()).toBe(true);
    expect(await h.service.check()).toMatchObject({ ok: false, code: "failed", message: INSTALLER_STARTED_MESSAGE });
    expect(h.adapter.installs).toHaveLength(1);
    expect(h.service.getState().error).toMatchObject({ context: "install", retryable: false });
  });

  it("refuses a restart request that was prepared for a quit and leaves it untouched", async () => {
    const h = setup();
    await h.ready();
    const token = await h.prepare("quit");
    expect(await h.service.install({ version: "1.1.0", channel: "stable" }, h.sessionFor(token))).toMatchObject({
      ok: false,
      code: "invalid"
    });
    expect(h.released).toEqual([]);
    expect(h.committed).toEqual([]);
    expect(h.coordinator.isIdle()).toBe(false);
  });

  it("postpones scheduled checks while a shutdown is being prepared", async () => {
    const tasks: Array<{ callback: () => void; delay: number }> = [];
    let idle = false;
    const h = setup({
      scheduler: {
        schedule: (callback, delay) => {
          tasks.push({ callback, delay });
          return () => {};
        }
      },
      canRunScheduledCheck: () => idle
    });
    h.service.start();
    tasks.shift()?.callback();
    await settle();
    expect(h.service.getState().phase).toBe("idle");
    expect(tasks.map((task) => task.delay)).toEqual([SUSPENDED_CHECK_RETRY_MS]);
    idle = true;
    tasks.shift()?.callback();
    await settle();
    expect(h.service.getState().phase).toBe("up-to-date");
  });

  it("starts the download when background downloads are turned on while an update is available", async () => {
    const h = setup({ autoDownload: false });
    h.adapter.checkResults.push(available("1.1.0"));
    await h.service.check();
    expect(h.service.getState().phase).toBe("available");
    h.service.setAutoDownload(true);
    await settle();
    expect(h.service.getState()).toMatchObject({ phase: "ready", downloadedVersion: "1.1.0" });
  });

  it("returns to ready with the error when the installer fails to start, and allows a retry", async () => {
    const h = setup();
    await h.ready();
    h.adapter.installError = new Error("No update filepath provided, can't quit and install");
    const first = await h.service.install({ version: "1.1.0", channel: "stable" }, h.sessionFor(await h.prepare()));
    expect(first).toMatchObject({ ok: false, code: "failed" });
    expect(first.ok ? "" : first.message).toMatch(/No update filepath provided/);
    expect(h.service.getState()).toMatchObject({ phase: "ready", error: { context: "install" } });
    expect(h.coordinator.isIdle()).toBe(true);

    h.adapter.installError = null;
    const retry = h.service.install({ version: "1.1.0", channel: "stable" }, h.sessionFor(await h.prepare()));
    await settle();
    expect(h.adapter.installs).toHaveLength(2);
    expect(h.service.getState()).toMatchObject({ phase: "installing", error: null });
    h.clock.fire(COMMIT_EXIT_TIMEOUT_MS);
    await retry;
  });

  it("reports a commit rejected by the coordinator without calling the installer", async () => {
    const h = setup();
    await h.ready();
    await h.prepare();
    const result = await h.service.install({ version: "1.1.0", channel: "stable" }, h.sessionFor("stale-token"));
    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(h.adapter.installs).toEqual([]);
    expect(h.service.getState()).toMatchObject({ phase: "ready", error: { context: "install", retryable: true } });
  });

  it("refuses to install in a disabled build", async () => {
    const h = setup({ environment: { isPackaged: false, resourcesPath: "", execPath: "" } });
    const token = await h.prepare();
    expect(await h.service.install({ version: "1.1.0", channel: "stable" }, h.sessionFor(token))).toMatchObject({
      ok: false,
      code: "disabled"
    });
    expect(h.released).toEqual([token]);
    expect(h.coordinator.isIdle()).toBe(true);
  });

  it("never installs from checks, downloads, preference changes or dispose", async () => {
    const h = setup();
    await h.ready();
    h.service.setAutoDownload(false);
    h.service.setAutoDownload(true);
    await h.service.setChannel("alpha");
    await h.service.check();
    h.service.dispose();
    expect(h.adapter.installs).toEqual([]);
  });
});
