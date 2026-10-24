import { describe, expect, it } from "bun:test";
import type { TaskSnapshot, ThreadEvent } from "@cw-code/contracts";
import { ToolTaskTracker, isSubagentToolName } from "./toolTasks.js";

const SESSION = "sess_1";

function trackerAt(...times: number[]): ToolTaskTracker {
  const queue = [...times];
  return new ToolTaskTracker(() => queue.shift() ?? 0);
}

const call = (toolCallId: string, turnId = "turn_1", name = "task", parentToolCallId?: string): ThreadEvent => ({
  type: "tool.call",
  turnId,
  toolCallId,
  name,
  input: { description: "Review" },
  ...(parentToolCallId !== undefined ? { parentToolCallId } : {})
});

const result = (toolCallId: string, output = "done", isError = false, turnId = "turn_1"): ThreadEvent => ({
  type: "tool.result",
  turnId,
  toolCallId,
  output,
  isError
});

const turnDone = (turnId = "turn_1", sessionId = SESSION): ThreadEvent => ({
  type: "turn.done",
  turnId,
  sessionId,
  resumeCursor: "cursor",
  resultText: "",
  usage: [],
  numTurns: 1,
  isError: false,
  backgroundTasks: 0
});

const turnError = (turnId = "turn_1"): ThreadEvent => ({ type: "turn.error", turnId, message: "boom" });

const running = (id: string, startedAt: number): TaskSnapshot => ({
  id,
  kind: "agent",
  background: false,
  state: "running",
  runCount: 1,
  startedAt
});

describe("isSubagentToolName", () => {
  it.each(["task", "Task", "agent", "AGENT"])("accepts %s", (name) => {
    expect(isSubagentToolName(name)).toBe(true);
  });

  it.each(["read", "bash", "tasks", ""])("rejects %j", (name) => {
    expect(isSubagentToolName(name)).toBe(false);
  });
});

describe("ToolTaskTracker call", () => {
  it("attaches a running snapshot to a subagent tool call", () => {
    const tracker = trackerAt(100);

    const out = tracker.observe(call("c1"), SESSION);

    expect(out).toEqual<unknown[]>([{ ...call("c1"), task: running("c1", 100) }]);
  });

  it("keeps the same snapshot when the call is re-emitted", () => {
    const tracker = trackerAt(100, 200);
    tracker.observe(call("c1"), SESSION);

    const out = tracker.observe(call("c1"), SESSION);

    expect(out).toEqual<unknown[]>([{ ...call("c1"), task: running("c1", 100) }]);
  });

  it("leaves non-subagent tool calls untouched", () => {
    const tracker = trackerAt(100);
    const event = call("c1", "turn_1", "read");

    expect(tracker.observe(event, SESSION)).toEqual([event]);
    expect(tracker.liveTasks(SESSION)).toEqual([]);
  });

  it("ignores nested calls that carry a parent tool call id", () => {
    const tracker = trackerAt(100);
    const nested = call("child-1", "turn_1", "task", "c1");

    expect(tracker.observe(nested, SESSION)).toEqual([nested]);
    expect(tracker.liveTasks(SESSION)).toEqual([]);
  });

  it("passes events through without a session id", () => {
    const tracker = trackerAt(100);
    const events = [call("c1"), result("c1"), turnError()];

    for (const event of events) expect(tracker.observe(event, undefined)).toEqual([event]);
    expect(tracker.liveTasks(SESSION)).toEqual([]);
  });
});

describe("ToolTaskTracker result", () => {
  it("completes the task on a successful result", () => {
    const tracker = trackerAt(100, 250);
    tracker.observe(call("c1"), SESSION);

    const out = tracker.observe(result("c1", "all good"), SESSION);

    expect(out).toEqual([
      result("c1", "all good"),
      {
        type: "task.updated",
        turnId: "turn_1",
        sessionId: SESSION,
        task: {
          id: "c1",
          kind: "agent",
          background: false,
          state: "completed",
          endReason: "tool-result",
          runCount: 1,
          startedAt: 100,
          endedAt: 250,
          output: "all good"
        }
      }
    ]);
  });

  it("fails the task on an error result", () => {
    const tracker = trackerAt(100, 250);
    tracker.observe(call("c1"), SESSION);

    const out = tracker.observe(result("c1", "no luck", true), SESSION);

    expect(out[1]).toMatchObject({
      type: "task.updated",
      task: { id: "c1", state: "failed", endReason: "tool-result", output: "no luck" }
    });
  });

  it("emits no update for a result that changes nothing", () => {
    const tracker = trackerAt(100, 250, 300);
    tracker.observe(call("c1"), SESSION);
    tracker.observe(result("c1"), SESSION);

    const repeat = result("c1");

    expect(tracker.observe(repeat, SESSION)).toEqual([repeat]);
  });

  it("reports the update under the turn that started the task", () => {
    const tracker = trackerAt(100, 250);
    tracker.observe(call("c1", "turn_1"), SESSION);

    const out = tracker.observe(result("c1", "done", false, "turn_2"), SESSION);

    expect(out[1]).toMatchObject({ type: "task.updated", turnId: "turn_1" });
  });

  it("passes through results for untracked tool calls", () => {
    const tracker = trackerAt(100);
    const event = result("child-1");

    expect(tracker.observe(event, SESSION)).toEqual([event]);
  });
});

describe("ToolTaskTracker turn end", () => {
  it("closes the open tasks of a finished turn as unknown before the event", () => {
    const tracker = trackerAt(100, 400);
    tracker.observe(call("c1"), SESSION);

    const out = tracker.observe(turnDone(), SESSION);

    expect(out).toEqual([
      {
        type: "task.updated",
        turnId: "turn_1",
        sessionId: SESSION,
        task: { ...running("c1", 100), state: "unknown", endReason: "no-record", endedAt: 400 }
      },
      turnDone()
    ]);
  });

  it("closes the open tasks of a failed turn as interrupted before the event", () => {
    const tracker = trackerAt(100, 400);
    tracker.observe(call("c1"), SESSION);

    const out = tracker.observe(turnError(), SESSION);

    expect(out).toEqual([
      {
        type: "task.updated",
        turnId: "turn_1",
        sessionId: SESSION,
        task: { ...running("c1", 100), state: "interrupted", endReason: "process-exit", endedAt: 400 }
      },
      turnError()
    ]);
  });

  it("only closes tasks that belong to the ending turn", () => {
    const tracker = trackerAt(100, 200, 400);
    tracker.observe(call("c1", "turn_1"), SESSION);
    tracker.observe(call("c2", "turn_2"), SESSION);

    const out = tracker.observe(turnDone("turn_1"), SESSION);

    expect(out.map((event) => event.type)).toEqual(["task.updated", "turn.done"]);
    expect(tracker.liveTasks(SESSION).find((task) => task.id === "c2")?.state).toBe("running");
    expect(tracker.observe(turnError("turn_2"), SESSION)[0]).toMatchObject({
      type: "task.updated",
      turnId: "turn_2",
      task: { id: "c2", state: "interrupted" }
    });
  });

  it("does not touch tasks that already ended", () => {
    const tracker = trackerAt(100, 250);
    tracker.observe(call("c1"), SESSION);
    tracker.observe(result("c1"), SESSION);

    expect(tracker.observe(turnDone(), SESSION)).toEqual([turnDone()]);
  });

  it("stops listing a turn's tasks once the turn is done", () => {
    const tracker = trackerAt(100, 250, 400);
    tracker.observe(call("c1"), SESSION);
    tracker.observe(result("c1"), SESSION);
    tracker.observe(call("c2"), SESSION);
    expect(tracker.liveTasks(SESSION).map((task) => task.state)).toEqual(["completed", "running"]);

    tracker.observe(turnDone(), SESSION);

    expect(tracker.liveTasks(SESSION)).toEqual([]);
  });

  it("stops listing a turn's tasks once the turn errors", () => {
    const tracker = trackerAt(100, 250, 400);
    tracker.observe(call("c1"), SESSION);
    tracker.observe(result("c1"), SESSION);

    tracker.observe(turnError(), SESSION);

    expect(tracker.liveTasks(SESSION)).toEqual([]);
  });

  it("keeps listing tasks that are still running in another turn", () => {
    const tracker = trackerAt(100, 200, 250, 400);
    tracker.observe(call("c1", "turn_1"), SESSION);
    tracker.observe(call("c2", "turn_2"), SESSION);
    tracker.observe(result("c1"), SESSION);

    tracker.observe(turnDone("turn_1"), SESSION);

    expect(tracker.liveTasks(SESSION)).toEqual([running("c2", 200)]);
    expect(tracker.observe(result("c2", "late", false, "turn_2"), SESSION)[1]).toMatchObject({
      type: "task.updated",
      turnId: "turn_2",
      task: { id: "c2", state: "completed" }
    });
  });

  it("does not resurrect a dropped task when its result arrives late", () => {
    const tracker = trackerAt(100, 250);
    tracker.observe(call("c1"), SESSION);
    tracker.observe(turnDone(), SESSION);

    const late = result("c1");

    expect(tracker.observe(late, SESSION)).toEqual([late]);
    expect(tracker.liveTasks(SESSION)).toEqual([]);
  });

  it("uses the session id of the turn.done event", () => {
    const tracker = trackerAt(100, 400);
    tracker.observe(call("c1"), SESSION);

    expect(tracker.observe(turnDone("turn_1", "other"), undefined)).toEqual([turnDone("turn_1", "other")]);
    expect(tracker.observe(turnDone(), undefined)[0]).toMatchObject({ type: "task.updated", sessionId: SESSION });
  });

  it("isolates tasks per session", () => {
    const tracker = trackerAt(100, 200, 400);
    tracker.observe(call("c1"), "sess_a");
    tracker.observe(call("c2"), "sess_b");

    tracker.observe(turnError(), "sess_a");

    expect(tracker.liveTasks("sess_a")).toEqual([]);
    expect(tracker.liveTasks("sess_b").map((task) => task.state)).toEqual(["running"]);
  });
});

describe("ToolTaskTracker closeOpen", () => {
  it("closes every open task of a session when no turn is given", () => {
    const tracker = trackerAt(100, 200, 400);
    tracker.observe(call("c1", "turn_1"), SESSION);
    tracker.observe(call("c2", "turn_2"), SESSION);

    const out = tracker.closeOpen(SESSION, "interrupted", "process-exit");

    expect(out.map((event) => event.type)).toEqual(["task.updated", "task.updated"]);
    expect(tracker.liveTasks(SESSION)).toEqual([]);
  });

  it("closes only the given turn when one is passed", () => {
    const tracker = trackerAt(100, 200, 400);
    tracker.observe(call("c1", "turn_1"), SESSION);
    tracker.observe(call("c2", "turn_2"), SESSION);

    const out = tracker.closeOpen(SESSION, "interrupted", "interrupt", "turn_2");

    expect(out).toEqual([
      {
        type: "task.updated",
        turnId: "turn_2",
        sessionId: SESSION,
        task: { ...running("c2", 200), state: "interrupted", endReason: "interrupt", endedAt: 400 }
      }
    ]);
    expect(tracker.liveTasks(SESSION)).toEqual([running("c1", 100)]);
  });

  it("returns nothing for an unknown session", () => {
    expect(trackerAt().closeOpen("nope", "interrupted", "process-exit")).toEqual([]);
  });
});

describe("ToolTaskTracker liveTasks and forget", () => {
  it("lists the snapshots tracked for a session", () => {
    const tracker = trackerAt(100, 200, 250);
    tracker.observe(call("c1"), SESSION);
    tracker.observe(call("c2"), SESSION);
    tracker.observe(result("c1"), SESSION);

    const tasks = tracker.liveTasks(SESSION);

    expect(tasks.map((task) => [task.id, task.state])).toEqual([
      ["c1", "completed"],
      ["c2", "running"]
    ]);
  });

  it("returns an empty list for an unknown session", () => {
    expect(trackerAt().liveTasks("nope")).toEqual([]);
  });

  it("drops everything tracked for a forgotten session", () => {
    const tracker = trackerAt(100, 200);
    tracker.observe(call("c1"), SESSION);

    tracker.forget(SESSION);

    expect(tracker.liveTasks(SESSION)).toEqual([]);
    const event = result("c1");
    expect(tracker.observe(event, SESSION)).toEqual([event]);
  });
});
