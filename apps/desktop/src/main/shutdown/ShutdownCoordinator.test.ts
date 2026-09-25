import { describe, expect, it } from "vitest";
import type { ShutdownActiveTurn, ShutdownReason, ShutdownTerminal } from "@cw-code/contracts";
import { ShutdownCoordinator, type ShutdownClock, type ShutdownPtys, type ShutdownSessions } from "./ShutdownCoordinator.js";

class FakeSessions implements ShutdownSessions {
  calls: string[] = [];
  turns: ShutdownActiveTurn[] = [];
  background = 0;
  timedOut: string[] = [];
  shutdownResult: Promise<{ timedOut: string[] }> | null = null;
  reserved = false;

  constructor(private log: string[]) {}

  private record(call: string): void {
    this.calls.push(call);
    this.log.push(`sessions.${call}`);
  }

  listShutdownTurns(): ShutdownActiveTurn[] {
    return [...this.turns];
  }
  backgroundTaskCount(): number {
    return this.background;
  }
  beginShutdownReservation(): void {
    this.reserved = true;
    this.record("reserve");
  }
  clearShutdownReservation(): void {
    this.reserved = false;
    this.record("release");
  }
  interrupt(turnId: string): void {
    this.turns = this.turns.filter((turn) => turn.turnId !== turnId);
    this.record(`interrupt:${turnId}`);
  }
  cancelBackgroundWork(): void {
    this.background = 0;
    this.record("cancelBackground");
  }
  flush(): void {
    this.record("flush");
  }
  shutdownDrivers(timeoutMs: number): Promise<{ timedOut: string[] }> {
    this.record(`shutdownDrivers:${timeoutMs}`);
    return this.shutdownResult ?? Promise.resolve({ timedOut: this.timedOut });
  }
  forceStopDrivers(): void {
    this.record("forceStop");
  }
  reinitializeDrivers(): void {
    this.record("reinitialize");
  }
}

class FakePtys implements ShutdownPtys {
  calls: string[] = [];
  terminals: ShutdownTerminal[] = [];
  reserved = false;

  constructor(private log: string[]) {}

  private record(call: string): void {
    this.calls.push(call);
    this.log.push(`ptys.${call}`);
  }

  list(): ShutdownTerminal[] {
    return [...this.terminals];
  }
  beginShutdownReservation(): void {
    this.reserved = true;
    this.record("reserve");
  }
  clearShutdownReservation(): void {
    this.reserved = false;
    this.record("release");
  }
  dispose(): void {
    this.terminals = [];
    this.record("dispose");
  }
  reopen(): void {
    this.record("reopen");
  }
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

function setup(opts: { clock?: ShutdownClock; commitExitTimeoutMs?: number; onRecovered?: (failure: string | null) => void; onExpired?: (reason: ShutdownReason) => void } = {}) {
  const log: string[] = [];
  const sessions = new FakeSessions(log);
  const ptys = new FakePtys(log);
  const clock = opts.clock ?? new ManualClock();
  let tokens = 0;
  const coordinator = new ShutdownCoordinator({
    sessions,
    ptys,
    clock,
    createToken: () => `token-${++tokens}`,
    commitExitTimeoutMs: opts.commitExitTimeoutMs ?? 5000,
    leaseMs: 60_000,
    onRecovered: opts.onRecovered,
    onExpired: opts.onExpired,
    log: () => {}
  });
  return { coordinator, sessions, ptys, log, clock };
}

function turn(sessionId: string, turnId: string): ShutdownActiveTurn {
  return { sessionId, turnId, title: `title ${sessionId}`, startedAt: 1 };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("ShutdownCoordinator.assess", () => {
  it("reports active turns from every session, background work and terminals", () => {
    const { coordinator, sessions, ptys } = setup();
    sessions.turns = [turn("sess_focused", "t1"), turn("sess_background", "t2")];
    sessions.background = 2;
    ptys.terminals = [{ ptyId: "sess_background:shell", sessionId: "sess_background", kind: "shell" }];
    expect(coordinator.assess()).toEqual({
      activeTurns: [turn("sess_focused", "t1"), turn("sess_background", "t2")],
      backgroundTasks: 2,
      terminals: [{ ptyId: "sess_background:shell", sessionId: "sess_background", kind: "shell" }]
    });
  });
});

describe("ShutdownCoordinator.prepare", () => {
  it("blocks on an active background session without stopping anything and releases the reservation", async () => {
    const { coordinator, sessions, ptys, log } = setup();
    sessions.turns = [turn("sess_background", "t2")];
    const result = await coordinator.prepare({ reason: "update", stopActiveTurns: false, timeoutMs: 1000 });
    expect(result).toEqual({
      ok: false,
      code: "blocked",
      assessment: { activeTurns: [turn("sess_background", "t2")], backgroundTasks: 0, terminals: [] }
    });
    expect(log).toEqual(["sessions.reserve", "ptys.reserve", "sessions.release", "ptys.release"]);
    expect(sessions.reserved).toBe(false);
    expect(ptys.reserved).toBe(false);
    expect(coordinator.isIdle()).toBe(true);
  });

  it("stops turns in every session, flushes, then closes terminals and drivers in order", async () => {
    const { coordinator, sessions, ptys, log } = setup();
    sessions.turns = [turn("sess_focused", "t1"), turn("sess_background", "t2")];
    sessions.background = 1;
    ptys.terminals = [{ ptyId: "sess_focused:claude", sessionId: "sess_focused", kind: "claude" }];
    const result = await coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1500 });
    expect(result).toEqual({ ok: true, token: "token-1" });
    expect(log).toEqual([
      "sessions.reserve",
      "ptys.reserve",
      "sessions.interrupt:t1",
      "sessions.interrupt:t2",
      "sessions.cancelBackground",
      "sessions.flush",
      "ptys.dispose",
      "sessions.shutdownDrivers:1500"
    ]);
    expect(sessions.reserved).toBe(true);
    expect(ptys.reserved).toBe(true);
  });

  it("proceeds without a dialog decision when nothing is running", async () => {
    const { coordinator } = setup();
    expect(await coordinator.prepare({ reason: "quit", stopActiveTurns: false, timeoutMs: 1000 })).toEqual({ ok: true, token: "token-1" });
  });

  it("rejects a concurrent prepare as busy while the first is still stopping drivers", async () => {
    const { coordinator, sessions } = setup();
    let finish: (value: { timedOut: string[] }) => void = () => {};
    sessions.shutdownResult = new Promise((resolve) => {
      finish = resolve;
    });
    const first = coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 });
    const second = await coordinator.prepare({ reason: "quit", stopActiveTurns: true, timeoutMs: 1000 });
    expect(second).toEqual({ ok: false, code: "busy" });
    finish({ timedOut: [] });
    expect(await first).toEqual({ ok: true, token: "token-1" });
    expect(await coordinator.prepare({ reason: "quit", stopActiveTurns: true, timeoutMs: 1000 })).toEqual({ ok: false, code: "busy" });
    expect(sessions.calls.filter((call) => call.startsWith("shutdownDrivers"))).toHaveLength(1);
  });

  it("turns a driver timeout into an explicit decision instead of hanging", async () => {
    const { coordinator, sessions } = setup();
    sessions.timedOut = ["claude"];
    const result = await coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 });
    expect(result).toEqual({ ok: false, code: "timeout", pending: ["claude"], token: "token-1" });
  });

  it("bounds a driver shutdown that never settles", async () => {
    const clock = new ManualClock();
    const { coordinator, sessions } = setup({ clock });
    sessions.shutdownResult = new Promise(() => {});
    const pending = coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 });
    await settle();
    clock.fire(3000);
    expect(await pending).toEqual({ ok: false, code: "timeout", pending: ["drivers"], token: "token-1" });
  });

  it("recovers when a stop step throws", async () => {
    const { coordinator, sessions } = setup();
    sessions.flush = () => {
      throw new Error("disk full");
    };
    await expect(coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 })).rejects.toThrow("disk full");
    expect(coordinator.isIdle()).toBe(true);
    expect(sessions.calls).toContain("reinitialize");
    expect(sessions.reserved).toBe(false);
  });
});

describe("ShutdownCoordinator timeout decisions", () => {
  it("force stops owned processes exactly once and then allows commit", async () => {
    const { coordinator, sessions } = setup();
    sessions.timedOut = ["codex"];
    const prepared = await coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 });
    if (prepared.ok || prepared.code !== "timeout") throw new Error("expected timeout");
    expect(await coordinator.commit(prepared.token, () => {})).toEqual({
      ok: false,
      message: "some processes have not stopped yet; force stop or cancel first"
    });
    expect(await coordinator.force(prepared.token)).toEqual({ ok: true, token: prepared.token });
    expect(await coordinator.force(prepared.token)).toEqual({ ok: true, token: prepared.token });
    expect(sessions.calls.filter((call) => call === "forceStop")).toHaveLength(1);
    let actions = 0;
    void coordinator.commit(prepared.token, () => {
      actions += 1;
    });
    await settle();
    expect(actions).toBe(1);
    expect(coordinator.isCommitted()).toBe(true);
  });

  it("cancel after a timeout restores services and releases the reservation", async () => {
    const { coordinator, sessions, ptys } = setup();
    sessions.timedOut = ["opencode"];
    const prepared = await coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 });
    if (prepared.ok || prepared.code !== "timeout") throw new Error("expected timeout");
    coordinator.cancel(prepared.token);
    expect(sessions.calls.slice(-2)).toEqual(["reinitialize", "release"]);
    expect(ptys.calls.slice(-2)).toEqual(["reopen", "release"]);
    expect(coordinator.isIdle()).toBe(true);
    await expect(coordinator.force(prepared.token)).rejects.toThrow("no longer valid");
  });
});

describe("ShutdownCoordinator cancellation and recovery", () => {
  it("cancel is idempotent and ignores calls when nothing is prepared", async () => {
    const { coordinator, sessions } = setup();
    coordinator.cancel("anything");
    const prepared = await coordinator.prepare({ reason: "quit", stopActiveTurns: true, timeoutMs: 1000 });
    if (!prepared.ok) throw new Error("expected ok");
    expect(() => coordinator.cancel("wrong-token")).toThrow("no longer valid");
    coordinator.cancel(prepared.token);
    coordinator.cancel(prepared.token);
    coordinator.recover();
    expect(sessions.calls.filter((call) => call === "reinitialize")).toHaveLength(1);
  });

  it("recovery during an in-flight prepare wins and the late prepare reports busy", async () => {
    const { coordinator, sessions } = setup();
    let finish: (value: { timedOut: string[] }) => void = () => {};
    sessions.shutdownResult = new Promise((resolve) => {
      finish = resolve;
    });
    const pending = coordinator.prepare({ reason: "quit", stopActiveTurns: true, timeoutMs: 1000 });
    await settle();
    coordinator.recover();
    finish({ timedOut: [] });
    expect(await pending).toEqual({ ok: false, code: "busy" });
    expect(coordinator.isIdle()).toBe(true);
    expect(sessions.reserved).toBe(false);
  });
});

describe("ShutdownCoordinator.commit", () => {
  it("recovers after a simulated installer-start failure and allows a retry", async () => {
    const { coordinator, sessions, ptys } = setup();
    sessions.turns = [turn("sess_a", "t1")];
    ptys.terminals = [{ ptyId: "sess_a:shell", sessionId: "sess_a", kind: "shell" }];
    const first = await coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 });
    if (!first.ok) throw new Error("expected ok");
    const failed = await coordinator.commit(first.token, () => {
      throw new Error("installer failed to start");
    });
    expect(failed).toEqual({
      ok: false,
      message: "cw-code could not finish the restart: installer failed to start. Normal use has been restored."
    });
    expect(coordinator.isIdle()).toBe(true);
    expect(sessions.reserved).toBe(false);
    expect(ptys.reserved).toBe(false);
    expect(sessions.calls.filter((call) => call === "reinitialize")).toHaveLength(1);
    expect(ptys.calls.filter((call) => call === "reopen")).toHaveLength(1);
    expect(await coordinator.commit(first.token, () => {})).toEqual({
      ok: false,
      message: "this restart request is no longer valid; start it again"
    });

    const retry = await coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 });
    expect(retry).toEqual({ ok: true, token: "token-2" });
    let installs = 0;
    void coordinator.commit("token-2", async () => {
      installs += 1;
    });
    await settle();
    expect(installs).toBe(1);
  });

  it("recovers when the process is still alive after the commit exit timeout", async () => {
    const clock = new ManualClock();
    const { coordinator, sessions } = setup({ clock, commitExitTimeoutMs: 4000 });
    const prepared = await coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 });
    if (!prepared.ok) throw new Error("expected ok");
    const result = coordinator.commit(prepared.token, () => {});
    await settle();
    expect(coordinator.isCommitted()).toBe(true);
    clock.fire(4000);
    expect(await result).toEqual({ ok: false, message: "cw-code did not exit within 4s. Normal use has been restored." });
    expect(coordinator.isIdle()).toBe(true);
    expect(sessions.calls).toContain("reinitialize");
  });

  it("runs the commit action once when quit is requested repeatedly", async () => {
    const clock = new ManualClock();
    const { coordinator } = setup({ clock });
    const prepared = await coordinator.prepare({ reason: "quit", stopActiveTurns: true, timeoutMs: 1000 });
    if (!prepared.ok) throw new Error("expected ok");
    let quits = 0;
    const quit = () => {
      quits += 1;
    };
    const first = coordinator.commit(prepared.token, quit);
    const second = coordinator.commit(prepared.token, quit);
    expect(second).toBe(first);
    expect(await coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 })).toEqual({ ok: false, code: "busy" });
    expect(() => coordinator.cancel(prepared.token)).toThrow("no longer valid");
    await settle();
    expect(quits).toBe(1);
    expect(coordinator.isCommitted()).toBe(true);
  });

  it("rejects a commit with a stale or unknown token", async () => {
    const { coordinator } = setup();
    expect(await coordinator.commit("token-x", () => {})).toEqual({
      ok: false,
      message: "this restart request is no longer valid; start it again"
    });
  });
});

describe("ShutdownCoordinator lease and approvals", () => {
  it("restores services when a prepared token is never used", async () => {
    const clock = new ManualClock();
    const expired: ShutdownReason[] = [];
    const { coordinator, sessions, ptys } = setup({ clock, onExpired: (reason) => expired.push(reason) });
    const prepared = await coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 });
    expect(prepared.ok).toBe(true);
    clock.fire(60_000);
    await settle();
    expect(coordinator.isIdle()).toBe(true);
    expect(expired).toEqual(["update"]);
    expect(sessions.calls).toContain("reinitialize");
    expect(sessions.reserved).toBe(false);
    expect(ptys.reserved).toBe(false);
  });

  it("restores services when a timeout decision is never made", async () => {
    const clock = new ManualClock();
    const { coordinator, sessions } = setup({ clock });
    sessions.timedOut = ["claude"];
    await coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 });
    clock.fire(60_000);
    await settle();
    expect(coordinator.isIdle()).toBe(true);
  });

  it("does not expire a token that is already committing", async () => {
    const clock = new ManualClock();
    const expired: ShutdownReason[] = [];
    const { coordinator, sessions } = setup({ clock, onExpired: (reason) => expired.push(reason) });
    const prepared = await coordinator.prepare({ reason: "quit", stopActiveTurns: true, timeoutMs: 1000 });
    if (!prepared.ok) throw new Error("expected ok");
    void coordinator.commit(prepared.token, () => {});
    await settle();
    clock.fire(60_000);
    await settle();
    expect(coordinator.isCommitted()).toBe(true);
    expect(expired).toEqual([]);
    expect(sessions.calls).not.toContain("reinitialize");
  });

  it("blocks instead of stopping turns that started after the user approved the stop", async () => {
    const { coordinator, sessions } = setup();
    sessions.turns = [turn("sess_a", "t1"), turn("sess_b", "t-new")];
    const result = await coordinator.prepare({ reason: "update", stopActiveTurns: true, approvedTurnIds: ["t1"], timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, code: "blocked" });
    expect(sessions.calls.some((call) => call.startsWith("interrupt"))).toBe(false);
    expect(sessions.reserved).toBe(false);
    const approvedAll = await coordinator.prepare({ reason: "update", stopActiveTurns: true, approvedTurnIds: ["t1", "t-new"], timeoutMs: 1000 });
    expect(approvedAll.ok).toBe(true);
  });

  it("reports a driver restart failure while still releasing reservations", async () => {
    const failures: Array<string | null> = [];
    const { coordinator, sessions, ptys } = setup({ onRecovered: (failure) => failures.push(failure) });
    sessions.reinitializeDrivers = () => {
      throw new Error("claude binary vanished");
    };
    const prepared = await coordinator.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 1000 });
    if (!prepared.ok) throw new Error("expected ok");
    coordinator.cancel(prepared.token);
    expect(failures).toEqual(["claude binary vanished"]);
    expect(sessions.reserved).toBe(false);
    expect(ptys.calls).toContain("reopen");
    expect(coordinator.isIdle()).toBe(true);
  });
});
