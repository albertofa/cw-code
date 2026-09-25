import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ShutdownPrepareRequest, ShutdownPrepareResult, UpdateActionResult, UpdatePhase, UpdateState } from "@cw-code/contracts";
import {
  BUSY_TURN_PROMPT,
  UPDATE_AUTOTEST_HANDOFF_FILE,
  UPDATE_AUTOTEST_MARKER,
  loadUpdateAutotest,
  resolveUpdateAutotest,
  runUpdateAutotest,
  type UpdateAutotestConfig,
  type UpdateAutotestHost,
  type UpdateAutotestIo
} from "./updateAutotest.js";

const ROOT = resolve("/cw-autotest");
const OUT = join(ROOT, "out.jsonl");
const HOME = join(ROOT, "home");
const USER_DATA = join(ROOT, "user-data");
const HANDOFF = join(USER_DATA, UPDATE_AUTOTEST_HANDOFF_FILE);

function state(phase: UpdatePhase, overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    seq: 1,
    phase,
    runningVersion: "0.0.1-alpha.9001",
    channel: "alpha",
    availableVersion: null,
    downloadedVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    progress: null,
    checkedAt: null,
    error: null,
    disabledReason: null,
    autoDownload: false,
    ...overrides
  };
}

class MemoryIo implements UpdateAutotestIo {
  files = new Map<string, string>();
  clock = 1_700_000_000_000;

  appendLine(path: string, line: string): void {
    this.files.set(path, (this.files.get(path) ?? "") + line);
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
  readText(path: string): string {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  }
  writeText(path: string, text: string): void {
    this.files.set(path, text);
  }
  remove(path: string): void {
    this.files.delete(path);
  }
  sleep(ms: number): Promise<void> {
    this.clock += ms;
    return Promise.resolve();
  }
  now(): number {
    return this.clock;
  }
  events(): Array<Record<string, unknown>> {
    return (this.files.get(OUT) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  eventNames(): string[] {
    return this.events().map((event) => String(event.event));
  }
}

interface FakeOptions {
  initial?: UpdateState;
  check?: UpdateActionResult;
  download?: UpdateActionResult;
  afterDownload?: UpdateState;
  prepare?: ShutdownPrepareResult[];
  install?: UpdateActionResult;
  activeTurns?: boolean;
}

function fakeHost(io: MemoryIo, options: FakeOptions = {}) {
  const calls: string[] = [];
  const prepareRequests: ShutdownPrepareRequest[] = [];
  const installRequests: Array<{ version: string; channel: string; token: string }> = [];
  const listeners = new Set<(value: UpdateState) => void>();
  let current = options.initial ?? state("idle");
  let turnStarted = false;
  const prepareResults = [...(options.prepare ?? [{ ok: true, token: "token-1" }])];
  const set = (next: UpdateState): void => {
    current = next;
    for (const listener of listeners) listener(next);
  };
  const available = state("available", { availableVersion: "0.0.1-alpha.9002" });
  const ready = state("ready", { availableVersion: "0.0.1-alpha.9002", downloadedVersion: "0.0.1-alpha.9002" });
  const host: UpdateAutotestHost = {
    version: "0.0.1-alpha.9001",
    pid: 4242,
    launchedByInstaller: false,
    startupMode: "ready",
    userDataDir: USER_DATA,
    updates: {
      getState: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      check: async () => {
        calls.push("check");
        const result = options.check ?? { ok: true, state: available };
        set(result.state);
        return result;
      },
      download: async () => {
        calls.push("download");
        set(state("downloading", { availableVersion: "0.0.1-alpha.9002", progress: { percent: 30, transferred: 30, total: 100, bytesPerSecond: 1 } }));
        set(state("downloading", { availableVersion: "0.0.1-alpha.9002", progress: { percent: 60, transferred: 60, total: 100, bytesPerSecond: 1 } }));
        set(state("downloading", { availableVersion: "0.0.1-alpha.9002", progress: { percent: 61, transferred: 61, total: 100, bytesPerSecond: 1 } }));
        const result = options.download ?? { ok: true, state: ready };
        set(options.afterDownload ?? result.state);
        return result;
      }
    },
    shutdown: {
      assess: () => ({
        activeTurns: (options.activeTurns ?? false) || turnStarted ? [{ sessionId: "sess_busy", turnId: "turn-1", title: "t", startedAt: 1 }] : [],
        backgroundTasks: 0,
        terminals: []
      }),
      prepare: async (request) => {
        calls.push("prepare");
        prepareRequests.push(request);
        return prepareResults.shift() ?? { ok: true, token: "token-x" };
      },
      force: async (token) => {
        calls.push(`force:${token}`);
        return { ok: true, token };
      },
      cancel: (token) => {
        calls.push(`cancel:${token}`);
      }
    },
    install: async (request) => {
      calls.push(`install:handoff=${io.exists(HANDOFF)}`);
      installRequests.push(request);
      return options.install ?? { ok: false, code: "failed", message: "cw-code did not exit within 30s. Normal use has been restored.", state: state("ready", { downloadedVersion: request.version }) };
    },
    startTurn: async (sessionId, prompt) => {
      calls.push(`startTurn:${sessionId}:${prompt}`);
      turnStarted = true;
      return "turn-1";
    },
    quit: () => {
      calls.push("quit");
    }
  };
  return { host, calls, prepareRequests, installRequests };
}

function config(overrides: Partial<UpdateAutotestConfig> = {}): UpdateAutotestConfig {
  return { mode: "install", outPath: OUT, cwCodeHome: HOME, busySessionId: null, pauseFile: null, fromVersion: null, ...overrides };
}

describe("resolveUpdateAutotest", () => {
  it("stays off without CW_UPDATE_AUTOTEST", () => {
    expect(resolveUpdateAutotest({}, null)).toEqual({ config: null, problem: null });
    expect(resolveUpdateAutotest({ CW_UPDATE_AUTOTEST: "  " }, null)).toEqual({ config: null, problem: null });
  });

  it("rejects unknown modes and relative paths", () => {
    expect(resolveUpdateAutotest({ CW_UPDATE_AUTOTEST: "publish", CW_UPDATE_AUTOTEST_OUT: OUT }, null).problem).toMatch(/must be one of/);
    expect(resolveUpdateAutotest({ CW_UPDATE_AUTOTEST: "install", CW_UPDATE_AUTOTEST_OUT: "out.jsonl" }, null).problem).toMatch(/absolute/);
    expect(resolveUpdateAutotest({ CW_UPDATE_AUTOTEST: "install" }, null).problem).toMatch(/absolute/);
    expect(
      resolveUpdateAutotest({ CW_UPDATE_AUTOTEST: "install", CW_UPDATE_AUTOTEST_OUT: OUT, CW_UPDATE_AUTOTEST_PAUSE_FILE: "pause" }, null).problem
    ).toMatch(/PAUSE_FILE/);
  });

  it("reads the mode, output, busy session, pause file and app home from the environment", () => {
    const resolved = resolveUpdateAutotest(
      {
        CW_UPDATE_AUTOTEST: "install",
        CW_UPDATE_AUTOTEST_OUT: OUT,
        CW_UPDATE_AUTOTEST_BUSY_SESSION: "sess_busy",
        CW_UPDATE_AUTOTEST_PAUSE_FILE: join(ROOT, "go"),
        CW_CODE_HOME: HOME
      },
      null
    );
    expect(resolved).toEqual({ config: config({ busySessionId: "sess_busy", pauseFile: join(ROOT, "go") }), problem: null });
  });

  it("switches to relaunch mode when a handoff exists, even without the environment", () => {
    const handoff = { marker: UPDATE_AUTOTEST_MARKER, outPath: OUT, cwCodeHome: HOME, fromVersion: "0.0.1-alpha.9001" };
    expect(resolveUpdateAutotest({ CW_UPDATE_AUTOTEST: "install", CW_UPDATE_AUTOTEST_OUT: join(ROOT, "other.jsonl") }, handoff)).toEqual({
      config: { mode: "relaunched", outPath: OUT, cwCodeHome: HOME, busySessionId: null, pauseFile: null, fromVersion: "0.0.1-alpha.9001" },
      problem: null
    });
  });

  it("refuses a malformed handoff", () => {
    expect(resolveUpdateAutotest({}, { marker: "other" }).problem).toMatch(/malformed/);
    expect(resolveUpdateAutotest({}, { marker: UPDATE_AUTOTEST_MARKER, outPath: "relative", cwCodeHome: null, fromVersion: "1" }).problem).toMatch(/malformed/);
  });
});

describe("loadUpdateAutotest", () => {
  it("consumes the handoff file once and restores the isolated app home", () => {
    const io = new MemoryIo();
    io.writeText(HANDOFF, JSON.stringify({ marker: UPDATE_AUTOTEST_MARKER, outPath: OUT, cwCodeHome: HOME, fromVersion: "0.0.1-alpha.9001" }));
    const env: Record<string, string | undefined> = {};
    const first = loadUpdateAutotest({ env, userDataDir: USER_DATA, io });
    expect(first.config?.mode).toBe("relaunched");
    expect(env.CW_CODE_HOME).toBe(HOME);
    expect(io.exists(HANDOFF)).toBe(false);
    expect(loadUpdateAutotest({ env: {}, userDataDir: USER_DATA, io })).toEqual({ config: null, problem: null });
  });

  it("never overrides an app home that is already set", () => {
    const io = new MemoryIo();
    io.writeText(HANDOFF, JSON.stringify({ marker: UPDATE_AUTOTEST_MARKER, outPath: OUT, cwCodeHome: HOME, fromVersion: "1.0.0" }));
    const env: Record<string, string | undefined> = { CW_CODE_HOME: join(ROOT, "explicit") };
    loadUpdateAutotest({ env, userDataDir: USER_DATA, io });
    expect(env.CW_CODE_HOME).toBe(join(ROOT, "explicit"));
  });

  it("removes an unreadable handoff and reports it", () => {
    const io = new MemoryIo();
    io.writeText(HANDOFF, "{not json");
    expect(loadUpdateAutotest({ env: {}, userDataDir: USER_DATA, io }).problem).toMatch(/malformed/);
    expect(io.exists(HANDOFF)).toBe(false);
  });
});

describe("runUpdateAutotest", () => {
  it("installs through check, download, the shutdown coordinator and the update service, leaving a handoff for the relaunch", async () => {
    const io = new MemoryIo();
    const fake = fakeHost(io);
    await runUpdateAutotest(config(), fake.host, io);
    expect(fake.calls).toEqual(["check", "download", "prepare", "install:handoff=true", "quit"]);
    expect(fake.prepareRequests).toEqual([{ reason: "update", stopActiveTurns: true, timeoutMs: 15_000, approvedTurnIds: [] }]);
    expect(fake.installRequests).toEqual([{ version: "0.0.1-alpha.9002", channel: "alpha", token: "token-1" }]);
    expect(io.exists(HANDOFF)).toBe(false);
    const events = io.events();
    expect(events[0]).toMatchObject({ event: "started", marker: UPDATE_AUTOTEST_MARKER, mode: "install", version: "0.0.1-alpha.9001", pid: 4242 });
    expect(events.filter((event) => event.event === "progress").map((event) => event.percent)).toEqual([25, 50]);
    expect(events.at(-2)).toMatchObject({ event: "result", outcome: "install-failed" });
    expect(events.at(-1)).toMatchObject({ event: "quitting" });
  });

  it("writes the handoff with the output path, app home and running version before installing", async () => {
    const io = new MemoryIo();
    const fake = fakeHost(io);
    let handoff: unknown = null;
    fake.host.install = async (request) => {
      handoff = JSON.parse(io.readText(HANDOFF));
      return { ok: false, code: "failed", message: "x", state: state("ready", { downloadedVersion: request.version }) };
    };
    await runUpdateAutotest(config(), fake.host, io);
    expect(handoff).toEqual({ marker: UPDATE_AUTOTEST_MARKER, outPath: OUT, cwCodeHome: HOME, fromVersion: "0.0.1-alpha.9001" });
  });

  it("stops a busy turn it started on purpose and approves exactly that turn", async () => {
    const io = new MemoryIo();
    const fake = fakeHost(io);
    await runUpdateAutotest(config({ busySessionId: "sess_busy" }), fake.host, io);
    expect(fake.calls).toEqual(["check", "download", `startTurn:sess_busy:${BUSY_TURN_PROMPT}`, "prepare", "install:handoff=true", "quit"]);
    expect(fake.prepareRequests[0].approvedTurnIds).toEqual(["turn-1"]);
    expect(io.events().find((event) => event.event === "assessment")).toMatchObject({ activeTurns: [{ sessionId: "sess_busy", turnId: "turn-1" }] });
  });

  it("forces a timed-out graceful stop before installing", async () => {
    const io = new MemoryIo();
    const fake = fakeHost(io, { prepare: [{ ok: false, code: "timeout", pending: ["drivers"], token: "token-t" }] });
    await runUpdateAutotest(config(), fake.host, io);
    expect(fake.calls).toEqual(["check", "download", "prepare", "force:token-t", "install:handoff=true", "quit"]);
  });

  it("gives up without installing when prepare is blocked", async () => {
    const io = new MemoryIo();
    const fake = fakeHost(io, { prepare: [{ ok: false, code: "busy" }] });
    await runUpdateAutotest(config(), fake.host, io);
    expect(fake.calls).toEqual(["check", "download", "prepare", "quit"]);
    expect(io.events().at(-2)).toMatchObject({ outcome: "prepare-failed" });
  });

  it("cancels the prepared restart in cancel mode", async () => {
    const io = new MemoryIo();
    const fake = fakeHost(io);
    await runUpdateAutotest(config({ mode: "cancel" }), fake.host, io);
    expect(fake.calls).toEqual(["check", "download", "prepare", "cancel:token-1", "quit"]);
    expect(io.events().at(-2)).toMatchObject({ outcome: "cancelled", state: { phase: "ready" } });
  });

  it("waits for the pause file before installing and times out otherwise", async () => {
    const io = new MemoryIo();
    const pauseFile = join(ROOT, "go");
    const fake = fakeHost(io);
    const originalSleep = io.sleep.bind(io);
    io.sleep = (ms) => {
      if (io.eventNames().includes("paused")) io.writeText(pauseFile, "go");
      return originalSleep(ms);
    };
    await runUpdateAutotest(config({ pauseFile }), fake.host, io);
    expect(io.eventNames()).toContain("resumed");
    expect(fake.calls).toContain("install:handoff=true");

    const idle = new MemoryIo();
    const blocked = fakeHost(idle);
    await runUpdateAutotest(config({ pauseFile }), blocked.host, idle);
    expect(blocked.calls).toEqual(["check", "download", "quit"]);
    expect(idle.events().at(-2)).toMatchObject({ outcome: "pause-timeout" });
  });

  it.each([
    ["up to date", { check: { ok: true, state: state("up-to-date") } }, "up-to-date", ["check", "quit"]],
    [
      "failed check",
      { check: { ok: false, code: "failed", message: "Could not reach the update server", state: state("error") } },
      "check-failed",
      ["check", "quit"]
    ],
    [
      "failed download",
      { download: { ok: false, code: "failed", message: "sha512 checksum mismatch", state: state("error") } },
      "download-failed",
      ["check", "download", "quit"]
    ]
  ] as const)("reports %s without installing", async (_label, options, outcome, calls) => {
    const io = new MemoryIo();
    const fake = fakeHost(io, options as FakeOptions);
    await runUpdateAutotest(config(), fake.host, io);
    expect(fake.calls).toEqual(calls);
    expect(io.events().at(-2)).toMatchObject({ event: "result", outcome });
  });

  it("stops after the check or the download in the check-only and download-only modes", async () => {
    const checkIo = new MemoryIo();
    const checkOnly = fakeHost(checkIo);
    await runUpdateAutotest(config({ mode: "check-only" }), checkOnly.host, checkIo);
    expect(checkOnly.calls).toEqual(["check", "quit"]);
    expect(checkIo.events().at(-2)).toMatchObject({ outcome: "available", state: { availableVersion: "0.0.1-alpha.9002" } });

    const downloadIo = new MemoryIo();
    const downloadOnly = fakeHost(downloadIo);
    await runUpdateAutotest(config({ mode: "download-only" }), downloadOnly.host, downloadIo);
    expect(downloadOnly.calls).toEqual(["check", "download", "quit"]);
    expect(downloadIo.events().at(-2)).toMatchObject({ outcome: "ready", state: { downloadedVersion: "0.0.1-alpha.9002" } });
  });

  it("reports disabled updates and recovery mode without touching the updater", async () => {
    const io = new MemoryIo();
    const disabled = fakeHost(io, { initial: state("disabled", { disabledReason: "This copy of cw-code was not installed with the Windows installer" }) });
    await runUpdateAutotest(config(), disabled.host, io);
    expect(disabled.calls).toEqual(["quit"]);
    expect(io.events().at(-2)).toMatchObject({ outcome: "disabled", state: { disabledReason: "This copy of cw-code was not installed with the Windows installer" } });

    const recoveryIo = new MemoryIo();
    const recovery = fakeHost(recoveryIo);
    recovery.host.startupMode = "recovery";
    recovery.host.updates = null;
    recovery.host.shutdown = null;
    await runUpdateAutotest(config(), recovery.host, recoveryIo);
    expect(recovery.calls).toEqual(["quit"]);
    expect(recoveryIo.events().at(-2)).toMatchObject({ outcome: "recovery-mode" });
  });

  it("records the relaunch, checks once and quits", async () => {
    const io = new MemoryIo();
    const fake = fakeHost(io, { check: { ok: true, state: state("up-to-date", { runningVersion: "0.0.1-alpha.9002" }) } });
    fake.host.version = "0.0.1-alpha.9002";
    fake.host.launchedByInstaller = true;
    await runUpdateAutotest(config({ mode: "relaunched", fromVersion: "0.0.1-alpha.9001" }), fake.host, io);
    expect(fake.calls).toEqual(["check", "quit"]);
    expect(io.eventNames()).toEqual(["started", "relaunched", "state", "check", "result", "quitting"]);
    expect(io.events()[1]).toMatchObject({ fromVersion: "0.0.1-alpha.9001", version: "0.0.1-alpha.9002", sameVersion: false, launchedByInstaller: true });
  });

  it("records a crash and still quits", async () => {
    const io = new MemoryIo();
    const fake = fakeHost(io);
    fake.host.startTurn = async () => {
      throw new Error("cw-code is preparing to restart");
    };
    await runUpdateAutotest(config({ busySessionId: "sess_busy" }), fake.host, io);
    expect(io.events().at(-2)).toMatchObject({ outcome: "crashed", message: "cw-code is preparing to restart" });
    expect(fake.calls.at(-1)).toBe("quit");
  });
});
