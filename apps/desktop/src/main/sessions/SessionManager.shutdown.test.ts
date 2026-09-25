import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CliDriver, DriverActivity, DriverKind, HistoryMessage, ThreadEvent, TurnHandle, TurnRequest } from "@cw-code/contracts";
import { SessionManager, type DriverFactory } from "./SessionManager.js";
import { SHUTDOWN_RESERVED_MESSAGE } from "../shutdown/shutdownReservation.js";

class LifecycleDriver implements CliDriver {
  started: TurnRequest[] = [];
  interrupted: string[] = [];
  disposed = 0;
  shutdowns: number[] = [];
  shutdownResult: Promise<{ timedOut: boolean }> | null = null;
  private running = new Map<string, string>();

  constructor(
    readonly kind: DriverKind,
    readonly emit: (event: ThreadEvent) => void
  ) {}

  async listSessions(): Promise<[]> {
    return [];
  }
  async getHistory(): Promise<HistoryMessage[]> {
    return [];
  }
  startTurn(request: TurnRequest): TurnHandle {
    const turnId = randomUUID();
    this.started.push(request);
    this.running.set(turnId, request.sessionId);
    return { turnId, events: (async function* () {})() };
  }
  interrupt(turnId: string): void {
    this.interrupted.push(turnId);
    this.running.delete(turnId);
  }
  async retryConnection(): Promise<{ status: "done"; history: HistoryMessage[] }> {
    return { status: "done", history: [] };
  }
  async renameSession(): Promise<void> {}
  async *events(): AsyncIterable<never> {}
  activity(): DriverActivity {
    return { busySessionIds: [...new Set(this.running.values())], ownedProcesses: this.running.size };
  }
  shutdown({ timeoutMs }: { timeoutMs: number }): Promise<{ timedOut: boolean }> {
    this.shutdowns.push(timeoutMs);
    return this.shutdownResult ?? Promise.resolve({ timedOut: false });
  }
  dispose(): void {
    this.disposed += 1;
  }
  runningTurns(): string[] {
    return [...this.running.keys()];
  }
}

class PlainDriver implements CliDriver {
  disposed = 0;
  constructor(readonly kind: DriverKind) {}
  async listSessions(): Promise<[]> {
    return [];
  }
  async getHistory(): Promise<HistoryMessage[]> {
    return [];
  }
  startTurn(): TurnHandle {
    return { turnId: randomUUID(), events: (async function* () {})() };
  }
  interrupt(): void {}
  async renameSession(): Promise<void> {}
  async *events(): AsyncIterable<never> {}
  dispose(): void {
    this.disposed += 1;
  }
}

interface Generation {
  claude: LifecycleDriver;
  opencode: LifecycleDriver;
  codex: PlainDriver;
}

function setup(opts: { failOnGeneration?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cw-shutdown-"));
  const generations: Generation[] = [];
  const factory: DriverFactory = (route) => {
    if (generations.length + 1 === opts.failOnGeneration) throw new Error("claude binary vanished");
    const generation: Generation = {
      claude: new LifecycleDriver("claude", route),
      opencode: new LifecycleDriver("opencode", route),
      codex: new PlainDriver("codex")
    };
    generations.push(generation);
    return generation;
  };
  const events: Array<{ sessionId: string; event: ThreadEvent }> = [];
  const manager = new SessionManager({
    dbPath: join(dir, "test.db"),
    settingsPath: join(dir, "settings.json"),
    worktreesRoot: join(dir, "worktrees"),
    driverFactory: factory,
    onEvent: (sessionId, event) => events.push({ sessionId, event })
  });
  manager.setSettings({ autoTitleEnabled: false });
  const project = manager.addProject(join(dir, "proj"));
  return { manager, generations, project, events };
}

describe("SessionManager shutdown reservation", () => {
  it("blocks every process-creating entry point with the restart message and unblocks after clearing", async () => {
    const { manager, project, generations } = setup();
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.beginShutdownReservation();
    await expect(manager.startTurn(session.id, "hello")).rejects.toThrow(SHUTDOWN_RESERVED_MESSAGE);
    await expect(manager.createSession(project.id, "claude", { mode: "current" })).rejects.toThrow(SHUTDOWN_RESERVED_MESSAGE);
    await expect(manager.retryConnection(session.id)).rejects.toThrow(SHUTDOWN_RESERVED_MESSAGE);
    await expect(manager.regenerateTitle(session.id)).rejects.toThrow(SHUTDOWN_RESERVED_MESSAGE);
    expect(generations[0].claude.started).toHaveLength(0);
    manager.clearShutdownReservation();
    await manager.startTurn(session.id, "hello");
    expect(generations[0].claude.started).toHaveLength(1);
  });

  it("rejects a turn whose start was already in flight when the reservation began", async () => {
    const { manager, project, generations } = setup();
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    const pending = manager.startTurn(session.id, "racing");
    manager.beginShutdownReservation();
    await expect(pending).rejects.toThrow(SHUTDOWN_RESERVED_MESSAGE);
    expect(generations[0].claude.started).toHaveLength(0);
    manager.clearShutdownReservation();
    await expect(manager.startTurn(session.id, "after")).resolves.toEqual(expect.any(String));
  });
});

describe("SessionManager shutdown inventory", () => {
  it("lists active turns from every session with titles and counts background title work", async () => {
    const { manager, project, generations } = setup();
    manager.setSettings({ autoTitleEnabled: true, autoTitleDriver: "opencode" });
    const focused = await manager.createSession(project.id, "claude", { mode: "current" });
    const background = await manager.createSession(project.id, "opencode", { mode: "current" });
    const focusedTurn = await manager.startTurn(focused.id, "focused work");
    const backgroundTurn = await manager.startTurn(background.id, "background work");
    const turns = manager.listShutdownTurns();
    expect(turns.map((turn) => [turn.sessionId, turn.turnId, turn.title])).toEqual([
      [focused.id, focusedTurn, "focused work"],
      [background.id, backgroundTurn, "background work"]
    ]);
    expect(manager.listBackgroundWork().map((work) => work.sessionId).sort()).toEqual([focused.id, background.id].sort());
    expect(manager.backgroundTaskCount()).toBe(2);
    manager.cancelBackgroundWork();
    expect(manager.listBackgroundWork()).toEqual([]);
    expect(generations[0].opencode.interrupted).toHaveLength(2);
  });

  it("marks interrupted turns as holding and never resends the prompt", async () => {
    const { manager, project, generations } = setup();
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    const turnId = await manager.startTurn(session.id, "long task");
    manager.interrupt(turnId);
    expect(manager.listShutdownTurns()).toEqual([]);
    expect((await manager.listSessions(project.id)).find((s) => s.id === session.id)?.status).toBe("holding");
    await manager.shutdownDrivers(100);
    manager.reinitializeDrivers();
    expect(generations[0].claude.started).toHaveLength(1);
    expect(generations[1].claude.started).toHaveLength(0);
  });

  it("includes sessions a driver reports busy even when no turn is tracked", async () => {
    const { manager, project, generations } = setup();
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    generations[0].claude.startTurn({ sessionId: session.id, prompt: "x", cwd: "." });
    expect(manager.listShutdownTurns()).toEqual([{ sessionId: session.id, turnId: `busy:${session.id}`, title: "New session", startedAt: 0 }]);
  });
});

describe("SessionManager driver lifecycle", () => {
  it("shuts down drivers gracefully, disposes drivers without shutdown support and reports timeouts", async () => {
    const { manager, generations } = setup();
    generations[0].opencode.shutdownResult = Promise.resolve({ timedOut: true });
    const result = await manager.shutdownDrivers(250);
    expect(result).toEqual({ timedOut: ["opencode"] });
    expect(generations[0].claude.shutdowns).toEqual([250]);
    expect(generations[0].opencode.shutdowns).toEqual([250]);
    expect(generations[0].codex.disposed).toBe(1);
    expect(generations[0].claude.disposed).toBe(0);
  });

  it("bounds a driver shutdown that never settles", async () => {
    const { manager, generations } = setup();
    generations[0].claude.shutdownResult = new Promise(() => {});
    const result = await manager.shutdownDrivers(10);
    expect(result.timedOut).toEqual(["claude"]);
  });

  it("rebuilds drivers after a failed shutdown, force-stopping the old ones exactly once", async () => {
    const { manager, project, generations, events } = setup();
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    await manager.shutdownDrivers(50);
    manager.forceStopDrivers();
    expect(generations[0].claude.disposed).toBe(1);
    manager.reinitializeDrivers();
    expect(generations).toHaveLength(2);
    expect(generations[0].claude.disposed).toBe(2);
    const turnId = await manager.startTurn(session.id, "after recovery");
    expect(generations[1].claude.started.map((request) => request.prompt)).toEqual(["after recovery"]);
    generations[0].claude.emit({ type: "turn.error", turnId, message: "stale driver" });
    expect(events.filter((entry) => entry.event.type === "turn.error")).toHaveLength(0);
    generations[1].claude.emit({ type: "assistant.delta", turnId, text: "fresh" });
    manager.flush();
    expect(events.filter((entry) => entry.event.type === "assistant.delta").map((entry) => entry.sessionId)).toEqual([session.id]);
  });

  it("recovers a disposed manager so it can be used again", async () => {
    const { manager, project, generations } = setup();
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.dispose();
    manager.reinitializeDrivers();
    await manager.startTurn(session.id, "still works");
    expect(generations[1].claude.started).toHaveLength(1);
    manager.dispose();
    expect(generations[1].claude.disposed).toBe(1);
  });
});

describe("SessionManager shutdown recovery", () => {
  it("publishes interrupted sessions when stopped for shutdown and again after drivers are rebuilt", async () => {
    const { manager, project } = setup();
    const updates: Array<{ id: string; status: string }> = [];
    manager.setSessionEmitter((session) => updates.push({ id: session.id, status: session.status }));
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    const turnId = await manager.startTurn(session.id, "long task");
    manager.beginShutdownReservation();
    manager.interrupt(turnId);
    expect(updates).toEqual([{ id: session.id, status: "holding" }]);
    manager.reinitializeDrivers();
    manager.clearShutdownReservation();
    expect(updates).toEqual([
      { id: session.id, status: "holding" },
      { id: session.id, status: "holding" }
    ]);
    manager.reinitializeDrivers();
    expect(updates).toHaveLength(2);
  });

  it("marks drivers unavailable with a visible message when they cannot be rebuilt", async () => {
    const { manager, project } = setup({ failOnGeneration: 2 });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    expect(() => manager.reinitializeDrivers()).toThrow("could not restart its CLI drivers");
    expect(manager.driverRestartFailure()).toContain("claude binary vanished");
    await expect(manager.startTurn(session.id, "hello")).rejects.toThrow("Quit and reopen cw-code");
  });
});
