import { describe, expect, it } from "bun:test";
import type { ApprovalRequest, SessionMeta, SessionStatus, SubagentResult } from "@cw-code/contracts";
import { parseWakePrompt } from "@cw-code/shared/subagents";
import { SessionBusyError } from "../sessions/SessionBusyError.js";
import { SHUTDOWN_RESERVED_MESSAGE } from "../shutdown/shutdownReservation.js";
import type { ThreadNotice } from "../threads/ThreadService.js";
import { SUBAGENT_DELIVERY_NOTICE_ID, SubagentDelivery } from "./SubagentDelivery.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { id, projectId: "p", driver: "claude", title: id, status: "idle", resumeCursor: "", createdAt: 0, updatedAt: 0, ...overrides };
}

function child(id: string, parentSessionId: string, result?: SubagentResult, delivered?: boolean, driver: SessionMeta["driver"] = "codex"): SessionMeta {
  return meta(id, { driver, subagent: { parentSessionId, isolation: "shared", ...(result ? { result } : {}), ...(delivered === undefined ? {} : { delivered }) } });
}

function result(turnId: string, outcome: SubagentResult["outcome"], at: number, text: string | null = `${turnId} text`): SubagentResult {
  return { turnId, outcome, text, at };
}

interface FakeRuntime {
  busy: boolean;
  approvals: ApprovalRequest[];
  questions: [];
}

function harness(initial: SessionMeta[]) {
  const sessions = [...initial];
  const runtime: FakeRuntime = { busy: false, approvals: [], questions: [] };
  const started: Array<{ sessionId: string; prompt: string }> = [];
  const delivered: Array<{ childId: string; turnId: string }> = [];
  const notices: Array<{ sessionId: string; notice: ThreadNotice }> = [];
  let shutdownReserved = false;
  let startTurn = async (): Promise<string> => "wake-turn";
  const delivery = new SubagentDelivery({
    sessions: () => sessions,
    runtime: () => runtime,
    startTurn: (sessionId, prompt) => {
      started.push({ sessionId, prompt });
      return startTurn();
    },
    markDelivered: (childId, turnId) => {
      delivered.push({ childId, turnId });
      const target = sessions.find((session) => session.id === childId);
      if (target?.subagent?.result?.turnId === turnId) target.subagent.delivered = true;
    },
    postNotice: (sessionId, notice) => {
      notices.push({ sessionId, notice });
      delivery.reevaluate(sessionId);
    },
    shutdownReserved: () => shutdownReserved
  });
  return {
    delivery,
    sessions,
    runtime,
    started,
    delivered,
    notices,
    setShutdownReserved(value: boolean) {
      shutdownReserved = value;
    },
    setStatus(id: string, status: SessionStatus) {
      const target = sessions.find((session) => session.id === id);
      if (target) target.status = status;
    },
    failStartWith(error: Error) {
      startTurn = async () => {
        throw error;
      };
    },
    succeedStart() {
      startTurn = async () => "wake-turn";
    },
    holdStart(): () => void {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      startTurn = async () => {
        await gate;
        return "wake-turn";
      };
      return release;
    }
  };
}

const DONE = result("t1", "done", 100);

describe("SubagentDelivery wakes", () => {
  it("starts one wake turn for a batch of children settling together", async () => {
    const h = harness([meta("parent"), child("b", "parent", result("tb", "done", 200)), child("a", "parent", result("ta", "error", 100, "boom"))]);
    h.delivery.reevaluate("parent");
    h.delivery.reevaluate("parent");
    h.delivery.reevaluate();
    await flush();

    expect(h.started).toHaveLength(1);
    expect(h.started[0].sessionId).toBe("parent");
    expect(parseWakePrompt(h.started[0].prompt)).toEqual([
      { subagentId: "a", driver: "codex", title: "a", outcome: "error", text: "boom" },
      { subagentId: "b", driver: "codex", title: "b", outcome: "done", text: "tb text" }
    ]);
    expect(h.delivered).toEqual([
      { childId: "a", turnId: "ta" },
      { childId: "b", turnId: "tb" }
    ]);

    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(1);
  });

  it("does not start a second wake while the first is still starting", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    const release = h.holdStart();
    h.delivery.reevaluate();
    await flush();
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(1);
    expect(h.delivered).toHaveLength(0);

    release();
    await flush();
    expect(h.delivered).toEqual([{ childId: "a", turnId: "t1" }]);
  });

  it("skips results the parent already received", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE, true), child("b", "parent", result("t2", "error", 200), true)]);
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);
  });

  it("ignores children that have no result yet", async () => {
    const h = harness([meta("parent"), child("a", "parent")]);
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);
  });

  it("waits while the parent is busy and wakes when it settles", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.runtime.busy = true;
    h.delivery.reevaluate("parent");
    await flush();
    expect(h.started).toHaveLength(0);

    h.runtime.busy = false;
    h.delivery.reevaluate("parent");
    await flush();
    expect(h.started).toHaveLength(1);
  });

  it("waits while the parent has a pending approval or question", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.runtime.approvals = [{ requestId: "r1" } as ApprovalRequest];
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);

    h.runtime.approvals = [];
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(1);
  });

  it("does not wake resolved or archived parents", async () => {
    const h = harness([meta("resolved", { status: "resolved" }), meta("archived", { status: "archived" }), child("a", "resolved", DONE), child("b", "archived", DONE)]);
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);
  });

  it("leaves out children that were resolved or archived", async () => {
    const archived = { ...child("a", "parent", DONE), status: "archived" as const };
    const resolved = { ...child("b", "parent", result("t2", "done", 200)), status: "resolved" as const };
    const h = harness([meta("parent"), archived, resolved, child("c", "parent", result("t3", "done", 300))]);
    h.delivery.reevaluate();
    await flush();

    expect(h.started).toHaveLength(1);
    expect(parseWakePrompt(h.started[0].prompt)?.map((entry) => entry.subagentId)).toEqual(["c"]);
  });

  it("does not wake when the only undelivered children are closed", async () => {
    const h = harness([meta("parent"), { ...child("a", "parent", DONE), status: "archived" }]);
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);
  });

  it("does not wake a parent that is itself a child", async () => {
    const h = harness([meta("root"), child("mid", "root"), child("leaf", "mid", DONE)]);
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);
  });

  it("does not wake a parent that does not exist", async () => {
    const h = harness([child("orphan", "gone", DONE)]);
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);
  });

  it("does not wake while shutdown is reserved and wakes after", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.setShutdownReserved(true);
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);

    h.setShutdownReserved(false);
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(1);
  });

  it("scopes a reevaluation to the given parent", async () => {
    const h = harness([meta("p1"), meta("p2"), child("a", "p1", DONE), child("b", "p2", result("t2", "done", 200))]);
    h.delivery.reevaluate("p2");
    await flush();
    expect(h.started.map((item) => item.sessionId)).toEqual(["p2"]);
  });
});

describe("SubagentDelivery interrupted results", () => {
  it("does not wake for interrupted results alone", async () => {
    const h = harness([meta("parent"), child("a", "parent", result("t1", "interrupted", 100, null))]);
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
  });

  it("includes interrupted results in a wake triggered by a done result", async () => {
    const h = harness([meta("parent"), child("a", "parent", result("t1", "interrupted", 50, null)), child("b", "parent", result("t2", "done", 100))]);
    h.delivery.reevaluate();
    await flush();

    expect(h.started).toHaveLength(1);
    expect(parseWakePrompt(h.started[0].prompt)?.map((entry) => [entry.subagentId, entry.outcome])).toEqual([
      ["a", "interrupted"],
      ["b", "done"]
    ]);
    expect(h.delivered).toEqual([
      { childId: "a", turnId: "t1" },
      { childId: "b", turnId: "t2" }
    ]);
  });
});

describe("SubagentDelivery failures", () => {
  it("posts a notice, marks nothing and retries on the next trigger", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.failStartWith(new Error("harness unavailable"));
    h.delivery.reevaluate();
    await flush();

    expect(h.started).toHaveLength(1);
    expect(h.delivered).toHaveLength(0);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].sessionId).toBe("parent");
    expect(h.notices[0].notice.noticeId).toBe(SUBAGENT_DELIVERY_NOTICE_ID);
    expect(h.notices[0].notice.severity).toBe("error");
    expect(h.notices[0].notice.text).toContain("harness unavailable");

    await flush();
    expect(h.started).toHaveLength(1);

    h.succeedStart();
    h.delivery.reevaluate("parent");
    await flush();
    expect(h.started).toHaveLength(2);
    expect(h.delivered).toEqual([{ childId: "a", turnId: "t1" }]);
    expect(h.notices).toHaveLength(1);
  });

  it("stays quiet when the parent turned busy or shutdown was reserved", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.failStartWith(new SessionBusyError("turn pending"));
    h.delivery.reevaluate();
    await flush();
    h.failStartWith(new Error(SHUTDOWN_RESERVED_MESSAGE));
    h.delivery.reevaluate();
    await flush();

    expect(h.started).toHaveLength(2);
    expect(h.notices).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
  });

  it("wakes again when a delivered child settles a new turn", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.delivery.reevaluate();
    await flush();
    expect(h.delivered).toEqual([{ childId: "a", turnId: "t1" }]);

    const link = h.sessions[1].subagent;
    if (link) h.sessions[1].subagent = { ...link, result: result("t2", "done", 300), delivered: false };
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(2);
    expect(parseWakePrompt(h.started[1].prompt)?.map((entry) => entry.text)).toEqual(["t2 text"]);
  });
});

describe("SubagentDelivery user stops", () => {
  it("holds wakes after a user stop until a non-wake turn starts, then delivers everything", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.delivery.turnStopped("parent");
    h.delivery.reevaluate("parent");
    await flush();
    expect(h.started).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);

    h.sessions.push(child("b", "parent", result("t2", "done", 200)));
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);

    h.delivery.turnStarted("parent", undefined);
    h.delivery.reevaluate("parent");
    await flush();
    expect(h.started).toHaveLength(1);
    expect(parseWakePrompt(h.started[0].prompt)?.map((entry) => entry.subagentId)).toEqual(["a", "b"]);
  });

  it("keeps holding when only a wake turn starts", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.delivery.turnStopped("parent");
    h.delivery.turnStarted("parent", "subagent-wake");
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);
  });

  it("only holds the stopped parent", async () => {
    const h = harness([meta("p1"), meta("p2"), child("a", "p1", DONE), child("b", "p2", result("t2", "done", 200))]);
    h.delivery.turnStopped("p1");
    h.delivery.reevaluate();
    await flush();
    expect(h.started.map((item) => item.sessionId)).toEqual(["p2"]);
  });

  it("does not hold on the stop of a subagent session", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.delivery.turnStopped("a");
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(1);
  });

  it("does not re-wake right after a stopped wake turn settles", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(1);

    h.delivery.turnStarted("parent", "subagent-wake");
    h.sessions.push(child("b", "parent", result("t2", "done", 200)));
    h.delivery.turnStopped("parent");
    h.delivery.reevaluate("parent");
    await flush();
    expect(h.started).toHaveLength(1);

    h.delivery.turnStarted("parent", undefined);
    h.delivery.reevaluate("parent");
    await flush();
    expect(h.started).toHaveLength(2);
    expect(parseWakePrompt(h.started[1].prompt)?.map((entry) => entry.subagentId)).toEqual(["b"]);
  });
});

describe("SubagentDelivery blocked wakes", () => {
  it("retries when reevaluated after the harness update that blocked the wake", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.failStartWith(new SessionBusyError("harness updating", "Codex is updating. Try again when the update finishes."));
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(1);
    expect(h.notices).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);

    h.succeedStart();
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(2);
    expect(h.delivered).toEqual([{ childId: "a", turnId: "t1" }]);
  });
});

describe("SubagentDelivery lifecycle", () => {
  it("wakes once for a persisted undelivered result on startup", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE, false)]);
    h.delivery.reactivate();
    await flush();
    h.delivery.reactivate();
    await flush();

    expect(h.started).toHaveLength(1);
    expect(h.delivered).toEqual([{ childId: "a", turnId: "t1" }]);
  });

  it("does not wake on startup for persisted interrupted results", async () => {
    const h = harness([meta("parent"), child("a", "parent", result("t1", "interrupted", 100, null), false)]);
    h.delivery.reactivate();
    await flush();
    expect(h.started).toHaveLength(0);
  });

  it("stops scheduling after dispose and resumes on reactivate", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.delivery.dispose();
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);

    h.delivery.reactivate();
    await flush();
    expect(h.started).toHaveLength(1);
  });

  it("drops an evaluation scheduled before dispose", async () => {
    const h = harness([meta("parent"), child("a", "parent", DONE)]);
    h.delivery.reevaluate();
    h.delivery.dispose();
    await flush();
    expect(h.started).toHaveLength(0);
  });

  it("wakes again when the parent is reopened after being resolved", async () => {
    const h = harness([meta("parent", { status: "resolved" }), child("a", "parent", DONE)]);
    h.delivery.reevaluate();
    await flush();
    expect(h.started).toHaveLength(0);

    h.setStatus("parent", "idle");
    h.delivery.reevaluate("parent");
    await flush();
    expect(h.started).toHaveLength(1);
  });
});
