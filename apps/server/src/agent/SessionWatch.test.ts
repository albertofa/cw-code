import { describe, expect, it } from "bun:test";
import type { SessionMeta, SessionStatus } from "@cw-code/contracts";
import type { SettledTurnEvent } from "../threads/ThreadService.js";
import { SessionWatch } from "./SessionWatch.js";

function session(status: SessionStatus, id = "s1"): SessionMeta {
  return { id, projectId: "p", driver: "claude", title: "Session", status, resumeCursor: "", createdAt: 0, updatedAt: 0 };
}

function turnDone(resultText: string): SettledTurnEvent {
  return {
    type: "turn.done",
    turnId: "t1",
    sessionId: "s1",
    resumeCursor: "",
    resultText,
    usage: [],
    numTurns: 1,
    isError: false,
    backgroundTasks: 0
  };
}

function setup(initial: SessionMeta[]) {
  const sessions = new Map(initial.map((meta) => [meta.id, meta]));
  const watch = new SessionWatch({ getSession: (id) => sessions.get(id) });
  const change = (meta: SessionMeta): void => {
    sessions.set(meta.id, meta);
    watch.sessionChanged(meta);
  };
  return { watch, change };
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  return (await Promise.race([promise, Promise.resolve(marker)])) === marker;
}

describe("SessionWatch", () => {
  it("resolves immediately when the session is not working", async () => {
    const { watch } = setup([session("idle")]);
    expect(await watch.wait("s1", 1_000)).toEqual({ status: "idle", lastResultText: null, timedOut: false });
  });

  it("rejects for an unknown session", async () => {
    const { watch } = setup([]);
    await expect(watch.wait("missing", 1_000)).rejects.toThrow("unknown session missing");
  });

  it("resolves when the session leaves working", async () => {
    const { watch, change } = setup([session("working")]);
    const pending = watch.wait("s1", 5_000);
    watch.turnSettled("s1", turnDone("all done"));
    change(session("input-required"));
    expect(await pending).toEqual({ status: "input-required", lastResultText: "all done", timedOut: false });
  });

  it("stays pending while changes keep the session working", async () => {
    const { watch, change } = setup([session("working")]);
    const pending = watch.wait("s1", 5_000);
    change(session("working"));
    expect(await isPending(pending)).toBe(true);
    change(session("idle"));
    expect((await pending).status).toBe("idle");
  });

  it("ignores changes of other sessions", async () => {
    const { watch, change } = setup([session("working"), session("working", "s2")]);
    const pending = watch.wait("s1", 5_000);
    change(session("idle", "s2"));
    expect(await isPending(pending)).toBe(true);
    change(session("idle"));
    expect((await pending).timedOut).toBe(false);
  });

  it("resolves as timed out with the current status", async () => {
    const { watch } = setup([session("working")]);
    expect(await watch.wait("s1", 10)).toEqual({ status: "working", lastResultText: null, timedOut: true });
  });

  it("resolves as timed out on abort", async () => {
    const { watch } = setup([session("working")]);
    const controller = new AbortController();
    const pending = watch.wait("s1", 5_000, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ status: "working", lastResultText: null, timedOut: true });
  });

  it("resolves as timed out when the signal is already aborted", async () => {
    const { watch } = setup([session("working")]);
    const result = await watch.wait("s1", 5_000, AbortSignal.abort());
    expect(result.timedOut).toBe(true);
  });

  it("records the result text of a finished turn and the message of a failed one", () => {
    const { watch } = setup([session("idle")]);
    expect(watch.lastResult("s1")).toBeNull();
    watch.turnSettled("s1", turnDone("first"));
    expect(watch.lastResult("s1")).toBe("first");
    watch.turnSettled("s1", { type: "turn.error", turnId: "t2", message: "boom" });
    expect(watch.lastResult("s1")).toBe("boom");
    watch.turnSettled("s1", { type: "turn.error", turnId: "t3", message: "" });
    expect(watch.lastResult("s1")).toBeNull();
  });

  it("settles pending waiters as timed out on dispose and keeps working afterwards", async () => {
    const { watch, change } = setup([session("working")]);
    const first = watch.wait("s1", 5_000);
    watch.dispose();
    expect(await first).toEqual({ status: "working", lastResultText: null, timedOut: true });

    const second = watch.wait("s1", 5_000);
    change(session("idle"));
    expect(await second).toEqual({ status: "idle", lastResultText: null, timedOut: false });
  });
});
