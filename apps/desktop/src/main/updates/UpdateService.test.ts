import { describe, expect, it } from "vitest";
import type { UpdateChannel, UpdateProgress, UpdateState } from "@cw-code/contracts";
import type { UpdaterAdapter, UpdaterCheckOutcome, UpdaterDownloadedInfo, UpdaterDownloadHandle } from "./ElectronUpdaterAdapter.js";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CHECK_INTERVAL_MS,
  DISABLED_IN_DEVELOPMENT,
  DISABLED_WITHOUT_FEED,
  DISABLED_WITHOUT_INSTALLER,
  FIRST_CHECK_DELAY_MS,
  FIRST_CHECK_JITTER_MS,
  UpdateService,
  detectDisabledReason,
  type UpdateEnvironment,
  type UpdateScheduler,
  type UpdateServiceOptions
} from "./UpdateService.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function outcome(version: string, available = true, releaseNotes: unknown = null): UpdaterCheckOutcome {
  return { available, info: { version, releaseName: `cw-code ${version}`, releaseNotes, releaseDate: "2026-09-24" } };
}

class FakeAdapter implements UpdaterAdapter {
  configured: UpdateChannel[] = [];
  checkCalls = 0;
  downloadCalls = 0;
  disposed = false;
  quitAndInstallCalls = 0;
  checkResults: Array<UpdaterCheckOutcome | null | Error | Deferred<UpdaterCheckOutcome | null>> = [];
  configureError: Error | null = null;
  downloadError: Error | null = null;
  downloads: Array<{ deferred: Deferred<void>; cancelled: boolean }> = [];
  private readonly progress = new Set<(progress: UpdateProgress) => void>();
  private readonly errors = new Set<(error: Error) => void>();
  private readonly downloaded = new Set<(info: UpdaterDownloadedInfo) => void>();

  configure(options: { channel: UpdateChannel }): void {
    if (this.configureError) throw this.configureError;
    this.configured.push(options.channel);
  }

  async check(): Promise<UpdaterCheckOutcome | null> {
    this.checkCalls += 1;
    const next = this.checkResults.shift();
    if (next === undefined) return outcome("0.0.0", false);
    if (next instanceof Error) throw next;
    if (next && "promise" in next) return next.promise;
    return next;
  }

  download(): UpdaterDownloadHandle {
    this.downloadCalls += 1;
    if (this.downloadError) throw this.downloadError;
    const entry = { deferred: deferred<void>(), cancelled: false };
    entry.deferred.promise.catch(() => undefined);
    this.downloads.push(entry);
    return {
      done: entry.deferred.promise,
      cancel: () => {
        entry.cancelled = true;
        entry.deferred.reject(Object.assign(new Error("cancelled"), { name: "CancellationError" }));
      }
    };
  }

  onProgress(listener: (progress: UpdateProgress) => void): () => void {
    this.progress.add(listener);
    return () => this.progress.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  onDownloaded(listener: (info: UpdaterDownloadedInfo) => void): () => void {
    this.downloaded.add(listener);
    return () => this.downloaded.delete(listener);
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls += 1;
  }

  dispose(): void {
    this.disposed = true;
  }

  emitProgress(percent: number): void {
    for (const listener of this.progress) listener({ percent, transferred: percent, total: 100, bytesPerSecond: 10 });
  }

  emitError(error: Error): void {
    for (const listener of this.errors) listener(error);
  }

  listenerCount(): number {
    return this.progress.size + this.errors.size + this.downloaded.size;
  }
}

class FakeScheduler implements UpdateScheduler {
  tasks: Array<{ callback: () => void; delay: number; cancelled: boolean; fired: boolean }> = [];

  schedule(callback: () => void, delayMs: number): () => void {
    const task = { callback, delay: delayMs, cancelled: false, fired: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  }

  pending(): Array<{ delay: number }> {
    return this.tasks.filter((task) => !task.cancelled && !task.fired);
  }

  fire(): void {
    const [task] = this.tasks.filter((candidate) => !candidate.cancelled && !candidate.fired);
    if (!task) throw new Error("no pending task");
    task.fired = true;
    task.callback();
  }
}

const INSTALLED: UpdateEnvironment = {
  isPackaged: true,
  resourcesPath: "C:\\Programs\\cw-code\\resources",
  execPath: "C:\\Programs\\cw-code\\cw-code.exe"
};

const HOME = "C:\\Users\\Jane";
const LATEST_PREFIX =
  "Unable to find latest version on GitHub (https://github.com/albertofa/cw-code/releases/latest), please ensure a production release exists: ";

interface Harness {
  service: UpdateService;
  adapter: FakeAdapter;
  scheduler: FakeScheduler;
  logs: string[];
  states: UpdateState[];
  adaptersCreated: () => number;
}

function harness(overrides: Partial<UpdateServiceOptions> = {}): Harness {
  const adapter = new FakeAdapter();
  const scheduler = new FakeScheduler();
  const logs: string[] = [];
  let created = 0;
  let now = 1_000;
  const service = new UpdateService({
    runningVersion: "1.0.0",
    environment: INSTALLED,
    files: { fileExists: () => true, listDirectory: () => ["cw-code.exe", "Uninstall cw-code.exe"] },
    createAdapter: () => {
      created += 1;
      return adapter;
    },
    logger: { info: (message) => logs.push(`info ${message}`), warn: (message) => logs.push(`warn ${message}`) },
    homeDir: HOME,
    scheduler,
    now: () => (now += 1_000),
    random: () => 0.5,
    ...overrides
  });
  const states: UpdateState[] = [];
  service.subscribe((state) => states.push(state));
  return { service, adapter, scheduler, logs, states, adaptersCreated: () => created };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("detectDisabledReason", () => {
  const installedFiles = { fileExists: () => true, listDirectory: () => ["cw-code.exe", "Uninstall cw-code.exe"] };

  it("explains development, missing feed, and non-installer copies in that order", () => {
    expect(detectDisabledReason({ ...INSTALLED, isPackaged: false }, installedFiles)).toBe(DISABLED_IN_DEVELOPMENT);
    expect(
      detectDisabledReason(INSTALLED, { ...installedFiles, fileExists: (path) => !path.endsWith("app-update.yml") })
    ).toBe(DISABLED_WITHOUT_FEED);
    const listed: string[] = [];
    expect(
      detectDisabledReason(INSTALLED, {
        fileExists: () => true,
        listDirectory: (path) => {
          listed.push(path);
          return ["cw-code.exe", "resources", "Uninstall.txt"];
        }
      })
    ).toBe(DISABLED_WITHOUT_INSTALLER);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatch(/Programs[\\/]cw-code$/);
    expect(detectDisabledReason(INSTALLED, installedFiles)).toBeNull();
  });

  it("accepts any NSIS uninstaller name, such as the update-test build", () => {
    const files = { fileExists: () => true, listDirectory: () => ["Uninstall cw-code-updatetest.exe"] };
    expect(detectDisabledReason(INSTALLED, files)).toBeNull();
  });

  it("treats an unreadable install directory as not installed", () => {
    const files = {
      fileExists: () => true,
      listDirectory: (): string[] => {
        throw new Error("EACCES");
      }
    };
    expect(detectDisabledReason(INSTALLED, files)).toBe(DISABLED_WITHOUT_INSTALLER);
  });
});

describe("UpdateService disabled builds", () => {
  it("never creates an updater and answers every action with the reason", async () => {
    const h = harness({ environment: { ...INSTALLED, isPackaged: false } });
    h.service.start();
    expect(h.scheduler.pending()).toHaveLength(0);
    expect(h.service.getState()).toMatchObject({ phase: "disabled", disabledReason: DISABLED_IN_DEVELOPMENT });
    for (const result of [await h.service.check(), await h.service.download(), await h.service.setChannel("alpha")]) {
      expect(result).toMatchObject({ ok: false, code: "disabled", message: DISABLED_IN_DEVELOPMENT });
    }
    expect(h.adaptersCreated()).toBe(0);
  });
});

describe("UpdateService checks", () => {
  it("derives the default channel from the running version and configures the adapter lazily", async () => {
    const h = harness({ runningVersion: "0.0.1-alpha.21" });
    expect(h.service.getState().channel).toBe("alpha");
    expect(h.adaptersCreated()).toBe(0);
    await h.service.check();
    expect(h.adapter.configured).toEqual(["alpha"]);
    expect(harness({ runningVersion: "1.0.0" }).service.getState().channel).toBe("stable");
  });

  it("publishes ordered states with increasing seq for an available update", async () => {
    const h = harness();
    h.adapter.checkResults.push(outcome("1.1.0", true, [{ version: "1.1.0", note: "Fixes" }]));
    const result = await h.service.check();
    expect(result).toMatchObject({ ok: true, state: { phase: "available", availableVersion: "1.1.0", releaseNotes: "## 1.1.0\n\nFixes" } });
    expect(h.states.map((state) => state.phase)).toEqual(["checking", "available"]);
    expect(h.states.map((state) => state.seq)).toEqual([1, 2]);
  });

  it("reports up-to-date when the feed has nothing newer", async () => {
    const h = harness();
    h.adapter.checkResults.push(outcome("1.0.0", false));
    expect(await h.service.check()).toMatchObject({ ok: true, state: { phase: "up-to-date" } });
  });

  it("never offers alpha or lower versions on the stable channel", async () => {
    const h = harness();
    h.adapter.checkResults.push(outcome("2.0.0-alpha.1"), outcome("0.9.0"), outcome("1.0.0"));
    for (let i = 0; i < 3; i++) {
      expect(await h.service.check()).toMatchObject({ ok: true, state: { phase: "up-to-date", availableVersion: null } });
    }
    expect(h.logs.filter((line) => line.includes("not eligible on the stable channel"))).toHaveLength(3);
  });

  it("never downgrades after switching from stable to alpha", async () => {
    const h = harness();
    await h.service.check();
    h.adapter.checkResults.push(outcome("0.9.0-alpha.3"));
    expect(await h.service.setChannel("alpha")).toMatchObject({ ok: true, state: { channel: "alpha" } });
    await settle();
    expect(h.adapter.configured).toEqual(["stable", "alpha"]);
    expect(h.service.getState()).toMatchObject({ phase: "up-to-date", availableVersion: null });
  });

  it("makes an alpha user on stable wait for a newer stable release", async () => {
    const h = harness({ runningVersion: "1.0.0-alpha.5" });
    h.adapter.checkResults.push(outcome("1.0.0-alpha.6"));
    await h.service.check();
    expect(h.service.getState()).toMatchObject({ phase: "available", availableVersion: "1.0.0-alpha.6" });
    h.adapter.checkResults.push(outcome("1.0.0-alpha.7"));
    await h.service.setChannel("stable");
    await settle();
    expect(h.service.getState()).toMatchObject({ channel: "stable", phase: "up-to-date", availableVersion: null });
    h.adapter.checkResults.push(outcome("1.0.0"));
    await h.service.check();
    expect(h.service.getState()).toMatchObject({ phase: "available", availableVersion: "1.0.0" });
  });

  it("dedupes concurrent check requests into one adapter call", async () => {
    const h = harness();
    const gate = deferred<UpdaterCheckOutcome | null>();
    h.adapter.checkResults.push(gate);
    const first = h.service.check();
    const second = h.service.check();
    expect(second).toBe(first);
    gate.resolve(outcome("1.1.0"));
    await first;
    expect(h.adapter.checkCalls).toBe(1);
  });

  it("surfaces a failed check as a typed, redacted, retryable error", async () => {
    const h = harness();
    h.adapter.checkResults.push(new Error(`Cannot download https://github.com/x/latest.yml?token=abc from ${HOME}\\cache`));
    const result = await h.service.check();
    expect(result).toMatchObject({
      ok: false,
      code: "failed",
      message: "Cannot download https://github.com/x/latest.yml from ~\\cache",
      state: { phase: "error", error: { context: "check", retryable: true } }
    });
    expect(h.logs.join("\n")).not.toMatch(/token=abc|Users\\Jane/);
  });

  it("treats a missing stable release as up to date on the stable channel", async () => {
    const h = harness();
    h.service.start();
    const missing = [
      Object.assign(new Error(`${LATEST_PREFIX}HttpError: 404 Not Found\nHeaders: {}`), { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" }),
      Object.assign(new Error("Cannot find latest.yml in the latest release artifacts"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" })
    ];
    for (const error of missing) {
      h.adapter.checkResults.push(error);
      expect(await h.service.check()).toMatchObject({ ok: true, state: { phase: "up-to-date", error: null } });
      expect(h.scheduler.pending().map((task) => task.delay)).toEqual([CHECK_INTERVAL_MS]);
    }
    expect(h.logs.filter((line) => line.startsWith("warn no stable release yet"))).toEqual([
      "warn no stable release yet (ERR_UPDATER_LATEST_VERSION_NOT_FOUND)",
      "warn no stable release yet (ERR_UPDATER_CHANNEL_FILE_NOT_FOUND)"
    ]);
  });

  it("keeps other /releases/latest failures as retryable errors with backoff", async () => {
    const causes = [
      "HttpError: 503 Service Unavailable",
      "HttpError: 502 Bad Gateway",
      "HttpError: 403 Forbidden\nx-ratelimit-remaining: 0",
      "HttpError: 429 Too many requests",
      "Error: Request timed out",
      "SyntaxError: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
      "Error: net::ERR_INTERNET_DISCONNECTED"
    ];
    for (const cause of causes) {
      const h = harness();
      h.service.start();
      h.adapter.checkResults.push(Object.assign(new Error(`${LATEST_PREFIX}${cause}`), { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" }));
      expect(await h.service.check()).toMatchObject({
        ok: false,
        code: "failed",
        state: { phase: "error", error: { context: "check", retryable: true } }
      });
      expect(h.scheduler.pending().map((task) => task.delay)).toEqual([BACKOFF_BASE_MS]);
    }
  });

  it("keeps a missing alpha channel file as an error", async () => {
    const alpha = harness({ runningVersion: "1.0.0-alpha.1" });
    alpha.adapter.checkResults.push(Object.assign(new Error("Cannot find alpha.yml"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" }));
    expect(await alpha.service.check()).toMatchObject({ ok: false, code: "failed", state: { phase: "error" } });
  });

  it("lets a check requested during a running check join it even with a download queued", async () => {
    const h = harness();
    const gate = deferred<UpdaterCheckOutcome | null>();
    h.adapter.checkResults.push(gate);
    const first = h.service.check();
    const download = h.service.download();
    expect(h.service.check()).toBe(first);
    gate.resolve(outcome("1.1.0"));
    await first;
    await settle();
    h.adapter.downloads[0].deferred.resolve();
    await download;
    expect(h.adapter.checkCalls).toBe(1);
  });

  it("reschedules and reports an operation that throws unexpectedly", async () => {
    const h = harness();
    h.service.start();
    h.adapter.checkResults.push({ available: true } as unknown as UpdaterCheckOutcome);
    h.scheduler.fire();
    await settle();
    expect(h.service.getState()).toMatchObject({ phase: "error", error: { context: "check" } });
    expect(h.scheduler.pending().map((task) => task.delay)).toEqual([BACKOFF_BASE_MS]);
    expect(h.logs.some((line) => line.includes("failed unexpectedly"))).toBe(true);
    h.adapter.checkResults.push({ available: true } as unknown as UpdaterCheckOutcome);
    h.scheduler.fire();
    await settle();
    expect(h.scheduler.pending().map((task) => task.delay)).toEqual([BACKOFF_BASE_MS * 2]);
  });

  it("releases the download lock when a download operation crashes", async () => {
    const h = harness({
      logger: {
        info: (message) => {
          if (message.startsWith("download started")) throw new Error("log sink broke");
        },
        warn: () => {}
      }
    });
    h.adapter.checkResults.push(outcome("1.1.0"));
    await h.service.check();
    expect(await h.service.download()).toMatchObject({
      ok: false,
      code: "failed",
      state: { phase: "error", error: { context: "download", message: "log sink broke" } }
    });
    expect(h.adapter.downloads[0].cancelled).toBe(true);
    expect(await h.service.check()).toMatchObject({ ok: true });
    expect(h.adapter.checkCalls).toBe(2);
  });

  it("treats an inactive updater as a non-retryable failure", async () => {
    const h = harness();
    h.adapter.checkResults.push(null);
    expect(await h.service.check()).toMatchObject({ ok: false, code: "failed", state: { error: { retryable: false } } });
  });

  it("logs adapter error events through the redactor", async () => {
    const h = harness();
    await h.service.check();
    h.adapter.emitError(new Error("bad Authorization: Bearer abcdefghijklmnopqrstuvwxyz"));
    expect(h.logs.some((line) => line.includes("updater error") && line.includes("<redacted>"))).toBe(true);
    expect(h.logs.join("\n")).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

describe("UpdateService downloads", () => {
  async function available(h: Harness, version = "1.1.0"): Promise<void> {
    h.adapter.checkResults.push(outcome(version));
    await h.service.check();
  }

  it("refuses to download before a check finds an update", async () => {
    const h = harness();
    expect(await h.service.download()).toMatchObject({ ok: false, code: "no-update" });
    h.adapter.checkResults.push(outcome("1.1.0"), new Error("offline"));
    await h.service.check();
    await h.service.check();
    expect(await h.service.download()).toMatchObject({ ok: false, code: "not-ready" });
    expect(h.adapter.downloadCalls).toBe(0);
  });

  it("downloads, tracks progress, logs bounded milestones, and becomes ready", async () => {
    const h = harness();
    await available(h);
    const pending = h.service.download();
    await settle();
    expect(h.service.getState().phase).toBe("downloading");
    for (const percent of [5, 20, 26, 30, 51, 74, 99, 100, 100]) h.adapter.emitProgress(percent);
    expect(h.service.getState().progress).toMatchObject({ percent: 100 });
    h.adapter.downloads[0].deferred.resolve();
    expect(await pending).toMatchObject({ ok: true, state: { phase: "ready", downloadedVersion: "1.1.0", progress: null } });
    const milestones = h.logs.filter((line) => line.includes("reached"));
    expect(milestones).toEqual([
      "info download 1.1.0 reached 25%",
      "info download 1.1.0 reached 50%",
      "info download 1.1.0 reached 75%",
      "info download 1.1.0 reached 100%"
    ]);
    const seqAfterReady = h.service.getState().seq;
    h.adapter.emitProgress(42);
    expect(h.service.getState().seq).toBe(seqAfterReady);
  });

  it("returns ok without downloading again when the update is already ready", async () => {
    const h = harness();
    await available(h);
    const pending = h.service.download();
    await settle();
    h.adapter.downloads[0].deferred.resolve();
    await pending;
    expect(await h.service.download()).toMatchObject({ ok: true, state: { phase: "ready" } });
    expect(h.adapter.downloadCalls).toBe(1);
  });

  it("dedupes concurrent download requests", async () => {
    const h = harness();
    await available(h);
    const first = h.service.download();
    const second = h.service.download();
    expect(second).toBe(first);
    await settle();
    h.adapter.downloads[0].deferred.resolve();
    await first;
    expect(h.adapter.downloadCalls).toBe(1);
  });

  it("answers busy to checks while a download holds the lock", async () => {
    const h = harness();
    await available(h);
    const pending = h.service.download();
    expect(await h.service.check()).toMatchObject({ ok: false, code: "busy" });
    await settle();
    h.adapter.downloads[0].deferred.resolve();
    await pending;
    expect(h.adapter.checkCalls).toBe(1);
  });

  it("serializes a download requested during a check behind that check", async () => {
    const h = harness();
    const gate = deferred<UpdaterCheckOutcome | null>();
    h.adapter.checkResults.push(gate);
    const check = h.service.check();
    const download = h.service.download();
    await settle();
    expect(h.adapter.downloadCalls).toBe(0);
    gate.resolve(outcome("1.1.0"));
    await check;
    await settle();
    expect(h.adapter.downloadCalls).toBe(1);
    h.adapter.downloads[0].deferred.resolve();
    expect(await download).toMatchObject({ ok: true, state: { phase: "ready" } });
  });

  it("reports a failed download as retryable and succeeds on retry", async () => {
    const h = harness();
    await available(h);
    const first = h.service.download();
    await settle();
    h.adapter.downloads[0].deferred.reject(Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_CHECKSUM_MISMATCH" }));
    expect(await first).toMatchObject({
      ok: false,
      code: "failed",
      state: { phase: "error", error: { context: "download", retryable: true } }
    });
    const retry = h.service.download();
    await settle();
    h.adapter.downloads[1].deferred.resolve();
    expect(await retry).toMatchObject({ ok: true, state: { phase: "ready", error: null } });
  });

  it("keeps a ready download through later failed and empty checks", async () => {
    const h = harness();
    await available(h);
    const pending = h.service.download();
    await settle();
    h.adapter.downloads[0].deferred.resolve();
    await pending;
    h.adapter.checkResults.push(new Error("offline"), outcome("1.0.0", false));
    expect(await h.service.check()).toMatchObject({ ok: false, state: { phase: "ready", downloadedVersion: "1.1.0" } });
    expect(await h.service.check()).toMatchObject({ ok: true, state: { phase: "ready", downloadedVersion: "1.1.0" } });
  });

  it("cancels and discards a download when the channel changes, ignoring late events", async () => {
    const h = harness({ runningVersion: "1.0.0-alpha.1" });
    await available(h, "1.0.0-alpha.2");
    const pending = h.service.download();
    await settle();
    h.adapter.emitProgress(30);
    const switched = h.service.setChannel("stable");
    expect(h.adapter.downloads[0].cancelled).toBe(true);
    h.adapter.emitProgress(60);
    expect(h.service.getState().progress).toMatchObject({ percent: 30 });
    expect(await pending).toMatchObject({ ok: false, code: "superseded" });
    expect(await switched).toMatchObject({
      ok: true,
      state: { channel: "stable", phase: "idle", availableVersion: null, downloadedVersion: null, progress: null }
    });
    await settle();
    expect(h.service.getState().phase).toBe("up-to-date");
  });

  it("keeps downloading a version the new channel still accepts, then retries the channel check", async () => {
    const h = harness();
    await available(h);
    const pending = h.service.download();
    await settle();
    const switched = h.service.setChannel("alpha");
    expect(h.adapter.downloads[0].cancelled).toBe(false);
    h.adapter.downloads[0].deferred.resolve();
    expect(await pending).toMatchObject({ ok: true, state: { phase: "ready", downloadedVersion: "1.1.0" } });
    expect(await switched).toMatchObject({ ok: true, state: { channel: "alpha", phase: "ready", downloadedVersion: "1.1.0" } });
    await settle();
    expect(h.adapter.checkCalls).toBe(2);
    expect(h.service.getState()).toMatchObject({ channel: "alpha", phase: "ready" });
  });

  it("gives a download requested after a channel change its own operation", async () => {
    const h = harness({ runningVersion: "1.0.0-alpha.1" });
    await available(h, "1.0.0-alpha.2");
    const old = h.service.download();
    await settle();
    const switched = h.service.setChannel("stable");
    const fresh = h.service.download();
    expect(fresh).not.toBe(old);
    expect(await old).toMatchObject({ ok: false, code: "superseded" });
    await switched;
    expect(await fresh).toMatchObject({ ok: false, code: "no-update" });
    await settle();
    expect(h.adapter.checkCalls).toBe(2);
  });

  it("leaves the download and channel alone when reconfiguring the updater fails", async () => {
    const h = harness({ runningVersion: "1.0.0-alpha.1" });
    await available(h, "1.0.0-alpha.2");
    const pending = h.service.download();
    await settle();
    h.adapter.configureError = new Error("bad channel");
    expect(await h.service.setChannel("stable")).toMatchObject({ ok: false, code: "failed", state: { channel: "alpha" } });
    expect(h.adapter.downloads[0].cancelled).toBe(false);
    h.adapter.configureError = null;
    h.adapter.downloads[0].deferred.resolve();
    expect(await pending).toMatchObject({ ok: true, state: { phase: "ready" } });
  });

  it("shows a download that could not start as a download error", async () => {
    const h = harness();
    await available(h);
    h.adapter.downloadError = new Error("updater could not start");
    expect(await h.service.download()).toMatchObject({
      ok: false,
      code: "failed",
      state: { phase: "error", error: { context: "download", message: "updater could not start" } }
    });
  });

  it("supersedes a queued download when the channel changes before it starts", async () => {
    const h = harness({ runningVersion: "1.0.0-alpha.1" });
    await available(h, "1.0.0-alpha.2");
    const gate = deferred<UpdaterCheckOutcome | null>();
    h.adapter.checkResults.push(gate);
    const check = h.service.check();
    const download = h.service.download();
    const switched = h.service.setChannel("stable");
    gate.resolve(outcome("1.0.0-alpha.3"));
    await check;
    expect(await download).toMatchObject({ ok: false, code: "superseded" });
    await switched;
    expect(h.adapter.downloadCalls).toBe(0);
  });

  it("does not cancel anything when the requested channel is already active", async () => {
    const h = harness();
    await available(h);
    const pending = h.service.download();
    await settle();
    expect(await h.service.setChannel("stable")).toMatchObject({ ok: true });
    expect(h.adapter.downloads[0].cancelled).toBe(false);
    h.adapter.downloads[0].deferred.resolve();
    await pending;
  });

  it("validates the channel argument", async () => {
    const h = harness();
    for (const bad of ["latest", "", undefined, 1, { channel: "alpha" }]) {
      expect(await h.service.setChannel(bad)).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  it("downloads automatically only when the policy flag is on", async () => {
    const off = harness();
    await available(off);
    await settle();
    expect(off.adapter.downloadCalls).toBe(0);
    const on = harness({ autoDownload: true });
    expect(on.service.getState().autoDownload).toBe(true);
    await available(on);
    await settle();
    expect(on.adapter.downloadCalls).toBe(1);
    expect(off.service.setAutoDownload(true)).toMatchObject({ ok: true, state: { autoDownload: true } });
  });

  it("never invokes the installer", async () => {
    const h = harness();
    await available(h);
    const pending = h.service.download();
    await settle();
    h.adapter.downloads[0].deferred.resolve();
    await pending;
    expect(h.adapter.quitAndInstallCalls).toBe(0);
  });
});

describe("UpdateService scheduling", () => {
  it("schedules the first check 45s after start within the jitter window", () => {
    const delays = [0, 0.5, 1].map((random) => {
      const h = harness({ random: () => random });
      h.service.start();
      h.service.start();
      expect(h.scheduler.pending()).toHaveLength(1);
      return h.scheduler.pending()[0].delay;
    });
    expect(delays).toEqual([
      FIRST_CHECK_DELAY_MS - FIRST_CHECK_JITTER_MS,
      FIRST_CHECK_DELAY_MS,
      FIRST_CHECK_DELAY_MS + FIRST_CHECK_JITTER_MS
    ]);
  });

  it("checks every six hours with up to 10% jitter after a success", async () => {
    const low = harness({ random: () => 0 });
    low.service.start();
    low.scheduler.fire();
    await settle();
    expect(low.adapter.checkCalls).toBe(1);
    expect(low.scheduler.pending().map((task) => task.delay)).toEqual([Math.round(CHECK_INTERVAL_MS * 0.9)]);
    const high = harness({ random: () => 1 });
    high.service.start();
    high.scheduler.fire();
    await settle();
    expect(high.scheduler.pending().map((task) => task.delay)).toEqual([Math.round(CHECK_INTERVAL_MS * 1.1)]);
  });

  it("backs off exponentially on errors, caps at six hours, and resets after a success", async () => {
    const h = harness();
    h.service.start();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      h.adapter.checkResults.push(new Error("offline"));
      h.scheduler.fire();
      await settle();
      delays.push(h.scheduler.pending()[0].delay);
    }
    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 64, 72, 72].map((factor) => Math.min(BACKOFF_BASE_MS * factor, BACKOFF_MAX_MS)));
    h.scheduler.fire();
    await settle();
    expect(h.scheduler.pending()[0].delay).toBe(CHECK_INTERVAL_MS);
    h.adapter.checkResults.push(new Error("offline"));
    h.scheduler.fire();
    await settle();
    expect(h.scheduler.pending()[0].delay).toBe(BACKOFF_BASE_MS);
  });

  it("lets a manual check bypass the schedule and resets the timer", async () => {
    const h = harness();
    h.service.start();
    const [first] = h.scheduler.tasks;
    await h.service.check();
    expect(first.cancelled).toBe(true);
    expect(h.scheduler.pending().map((task) => task.delay)).toEqual([CHECK_INTERVAL_MS]);
  });

  it("reschedules a timer that fires while a download holds the lock", async () => {
    const h = harness();
    h.service.start();
    h.adapter.checkResults.push(outcome("1.1.0"));
    h.scheduler.fire();
    await settle();
    const pending = h.service.download();
    await settle();
    h.scheduler.fire();
    await settle();
    expect(h.adapter.checkCalls).toBe(1);
    expect(h.scheduler.pending().map((task) => task.delay)).toEqual([CHECK_INTERVAL_MS]);
    h.adapter.downloads[0].deferred.resolve();
    await pending;
  });
});

describe("UpdateService dispose", () => {
  it("clears timers, cancels downloads, detaches listeners, and stops publishing", async () => {
    const h = harness();
    h.service.start();
    h.adapter.checkResults.push(outcome("1.1.0"));
    await h.service.check();
    const pending = h.service.download();
    await settle();
    const published = h.states.length;
    h.service.dispose();
    expect(h.scheduler.pending()).toHaveLength(0);
    expect(h.adapter.downloads[0].cancelled).toBe(true);
    expect(h.adapter.disposed).toBe(true);
    expect(h.adapter.listenerCount()).toBe(0);
    expect(await pending).toMatchObject({ ok: false, code: "superseded" });
    expect(h.states).toHaveLength(published);
    expect(await h.service.check()).toMatchObject({ ok: false, code: "disabled" });
    h.service.dispose();
  });
});
