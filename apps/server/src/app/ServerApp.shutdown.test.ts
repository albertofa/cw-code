import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerApp as ServerAppType } from "./ServerApp.js";
import type { Services } from "./services.js";

const actualOrphans = await import("../orphanServers.js");
mock.module("../orphanServers.js", () => ({
  ...actualOrphans,
  reapOrphanedServers: (deps?: Parameters<typeof actualOrphans.reapOrphanedServers>[0]) =>
    deps ? actualOrphans.reapOrphanedServers(deps) : Promise.resolve([])
}));

const { ServerApp } = await import("./ServerApp.js");

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let home = "";
let previousHome: string | undefined;
let app: ServerAppType;
let services: Services;

beforeAll(() => {
  previousHome = process.env.CW_CODE_HOME;
  home = mkdtempSync(join(tmpdir(), "cw-server-app-shutdown-"));
  process.env.CW_CODE_HOME = home;
  app = new ServerApp({ host: null, port: 0, parentPid: null, legacyUserData: [], allowOrigins: [] }, "test");
  app.reboot();
  const running = app.currentServices();
  if (!running) throw new Error("services did not start");
  services = running;
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.CW_CODE_HOME;
  else process.env.CW_CODE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function publishes() {
  const full = spyOn(services.appTopic, "setShutdown");
  const statusOnly = spyOn(services.appTopic, "setShutdownStatus");
  return { full, statusOnly, reset: () => (full.mockClear(), statusOnly.mockClear()) };
}

function changeRuntime(sessionId: string): void {
  const begun = services.threads.beginTurn(sessionId, "hello", false);
  services.threads.abortTurn(sessionId, begun);
}

describe("ServerApp shutdown assessment publishing", () => {
  test("publishes when a task, a title or a session changes, coalescing bursts", async () => {
    await settle();
    const spy = publishes();
    spy.reset();

    app.emit("turn.event", { sessionId: "s1", turnId: "t1", event: { type: "task.updated" } });
    await settle();
    expect(spy.full).toHaveBeenCalledTimes(1);

    app.emit("session.title", { sessionId: "s1", title: "renamed" });
    await settle();
    expect(spy.full).toHaveBeenCalledTimes(2);

    app.emit("session.updated", { id: "s1" });
    await settle();
    expect(spy.full).toHaveBeenCalledTimes(3);

    spy.reset();
    app.emit("session.title", { sessionId: "s1", title: "a" });
    app.emit("session.updated", { id: "s1" });
    app.emit("turn.event", { sessionId: "s1", turnId: "t1", event: { type: "task.updated" } });
    await settle();
    expect(spy.full).toHaveBeenCalledTimes(1);

    spy.reset();
    app.emit("turn.event", { sessionId: "s1", turnId: "t1", event: { type: "assistant.delta" } });
    await settle();
    expect(spy.full).not.toHaveBeenCalled();
  });

  test("publishes when a driver reports that its activity ended", async () => {
    const spy = publishes();
    spy.reset();
    (services.sessions as unknown as { notifyDriverActivity(): void }).notifyDriverActivity();
    await settle();
    expect(spy.full).toHaveBeenCalledTimes(1);
  });

  test("skips the assessment while services are disposed and recovers with a single publish per change", async () => {
    const spy = publishes();
    const prepared = await services.shutdown.prepare({ reason: "quit", stopActiveTurns: true, timeoutMs: 100 });
    expect(prepared.ok).toBe(true);
    (app as unknown as { disposeServices(): void }).disposeServices();
    await settle();

    spy.reset();
    app.emit("session.title", { sessionId: "s1", title: "while disposed" });
    app.emitShutdownChanged();
    await settle();
    expect(spy.full).not.toHaveBeenCalled();
    expect(spy.statusOnly).toHaveBeenCalledTimes(1);
    expect(spy.statusOnly.mock.calls[0]?.[0]).toMatchObject({ idle: false, committed: false });

    services.shutdown.recover();
    await settle();
    expect(spy.full).toHaveBeenCalledTimes(1);

    spy.reset();
    changeRuntime("s2");
    await settle();
    expect(spy.full).toHaveBeenCalledTimes(1);

    changeRuntime("s2");
    await settle();
    expect(spy.full).toHaveBeenCalledTimes(2);
  });
});
