import { describe, expect, it } from "vitest";
import { TaskTable, mapCliTaskStatus, stateRank, type TaskObservation, type TaskOutputSource } from "./TaskTable.js";

function tableWith(...observations: TaskObservation[]): TaskTable {
  const table = new TaskTable();
  for (const obs of observations) table.apply(obs);
  return table;
}

const agentCall = (toolUseId: string, at: number, background?: boolean): TaskObservation => ({
  kind: "call",
  toolUseId,
  taskKind: "agent",
  ...(background !== undefined ? { background } : {}),
  at
});

describe("stateRank", () => {
  it("orders running < unknown < interrupted < terminal", () => {
    expect(stateRank("running")).toBe(0);
    expect(stateRank("unknown")).toBe(1);
    expect(stateRank("interrupted")).toBe(2);
    expect(stateRank("completed")).toBe(3);
    expect(stateRank("failed")).toBe(3);
    expect(stateRank("stopped")).toBe(3);
  });
});

describe("mapCliTaskStatus", () => {
  it.each([
    ["pending", "running"],
    ["running", "running"],
    ["in_progress", "running"],
    ["paused", "running"],
    ["completed", "completed"],
    ["success", "completed"],
    ["failed", "failed"],
    ["error", "failed"],
    ["killed", "stopped"],
    ["stopped", "stopped"],
    ["cancelled", "stopped"],
    ["canceled", "stopped"],
    ["aborted", "stopped"],
    ["  Completed ", "completed"],
    ["IN_PROGRESS", "running"]
  ])("maps %j to %s", (status, expected) => {
    expect(mapCliTaskStatus(status)).toBe(expected);
  });

  it("returns undefined for unknown or missing statuses", () => {
    expect(mapCliTaskStatus(undefined)).toBeUndefined();
    expect(mapCliTaskStatus("")).toBeUndefined();
    expect(mapCliTaskStatus("queued")).toBeUndefined();
    expect(mapCliTaskStatus("toString")).toBeUndefined();
  });
});

describe("TaskTable call", () => {
  it("creates a running record keyed by the tool use id", () => {
    const table = new TaskTable();
    expect(table.apply(agentCall("tu_1", 100))).toStrictEqual([
      { id: "tu_1", kind: "agent", background: false, state: "running", runCount: 1, startedAt: 100 }
    ]);
    expect(table.get("tu_1")).toStrictEqual({ id: "tu_1", kind: "agent", background: false, state: "running", runCount: 1, startedAt: 100 });
  });

  it("only fills unknown fields when the record already exists", () => {
    const table = tableWith(agentCall("tu_1", 100));
    expect(table.apply({ kind: "call", toolUseId: "tu_1", taskKind: "shell", background: true, at: 200 })).toStrictEqual([
      { id: "tu_1", kind: "agent", background: true, state: "running", runCount: 1, startedAt: 100 }
    ]);
    expect(table.apply({ kind: "call", toolUseId: "tu_1", taskKind: "agent", background: false, at: 300 })).toEqual([]);
    expect(table.get("tu_1")?.background).toBe(true);
  });
});

describe("TaskTable ended", () => {
  it("ends a call on its tool result", () => {
    const table = tableWith(agentCall("tu_1", 100, false));
    expect(
      table.apply({
        kind: "ended",
        ref: { toolUseId: "tu_1" },
        state: "completed",
        reason: "tool-result",
        output: "done",
        outputSource: "result",
        usage: { tokens: 42 },
        at: 150
      })
    ).toStrictEqual([
      {
        id: "tu_1",
        kind: "agent",
        background: false,
        state: "completed",
        endReason: "tool-result",
        runCount: 1,
        startedAt: 100,
        endedAt: 150,
        output: "done",
        usage: { tokens: 42 }
      }
    ]);
  });

  it("never lowers the state rank and keeps the first terminal time", () => {
    const table = tableWith(agentCall("tu_1", 100));
    table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "unknown", reason: "roster", at: 110 });
    expect(table.get("tu_1")).toMatchObject({ state: "unknown", endReason: "roster", endedAt: 110 });

    table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "interrupted", reason: "interrupt", at: 120 });
    expect(table.get("tu_1")).toMatchObject({ state: "interrupted", endReason: "interrupt", endedAt: 110 });

    table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "completed", reason: "cli", at: 130 });
    expect(table.get("tu_1")).toMatchObject({ state: "completed", endReason: "cli", endedAt: 110 });

    table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "stopped", reason: "sidecar", at: 140 });
    expect(table.get("tu_1")).toMatchObject({ state: "stopped", endReason: "sidecar", endedAt: 110 });

    expect(table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "unknown", reason: "roster", at: 150 })).toEqual([]);
    expect(table.get("tu_1")).toMatchObject({ state: "stopped", endReason: "sidecar" });
  });

  it("merges output and usage even when the state does not change", () => {
    const table = tableWith(agentCall("tu_1", 100));
    table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "completed", reason: "cli", at: 110 });
    const changed = table.apply({
      kind: "ended",
      ref: { originId: "tu_1" },
      state: "unknown",
      reason: "roster",
      output: "late summary",
      usage: { durationMs: 5 },
      at: 120
    });
    expect(changed).toStrictEqual([
      {
        id: "tu_1",
        kind: "agent",
        background: false,
        state: "completed",
        endReason: "cli",
        runCount: 1,
        startedAt: 100,
        endedAt: 110,
        output: "late summary",
        usage: { durationMs: 5 }
      }
    ]);
  });

  it("keeps a handback report over a later notification summary but upgrades usage", () => {
    const table = tableWith(agentCall("tu_1", 100, true));
    table.apply({
      kind: "ended",
      ref: { originId: "tu_1" },
      state: "completed",
      reason: "cli",
      output: "full report",
      outputSource: "report",
      usage: { tokens: 10 },
      at: 200
    });
    const changed = table.apply({
      kind: "ended",
      ref: { toolUseId: "tu_1" },
      state: "completed",
      reason: "cli",
      output: "short summary",
      outputSource: "summary",
      usage: { tokens: undefined, toolUses: 3 },
      at: 210
    });
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ output: "full report", usage: { tokens: 10, toolUses: 3 }, endedAt: 200 });
    expect(table.get("tu_1")?.usage).toStrictEqual({ tokens: 10, toolUses: 3 });
  });

  it("replaces output only with an equal or higher source", () => {
    const table = tableWith(agentCall("tu_1", 100));
    const end = (output: string, outputSource?: TaskOutputSource): TaskObservation => ({
      kind: "ended",
      ref: { originId: "tu_1" },
      state: "completed",
      reason: "cli",
      output,
      ...(outputSource !== undefined ? { outputSource } : {}),
      at: 200
    });

    table.apply(end("first summary"));
    table.apply(end("second summary"));
    expect(table.get("tu_1")?.output).toBe("second summary");

    table.apply(end("final report", "report"));
    expect(table.get("tu_1")?.output).toBe("final report");

    expect(table.apply(end("tool result", "result"))).toEqual([]);
    expect(table.apply(end("another summary"))).toEqual([]);
    expect(table.get("tu_1")?.output).toBe("final report");

    table.apply(end("revised report", "report"));
    expect(table.get("tu_1")?.output).toBe("revised report");
  });

  it("ignores empty output", () => {
    const table = tableWith(agentCall("tu_1", 100));
    table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "completed", reason: "cli", output: "summary", at: 110 });
    expect(table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "completed", reason: "cli", output: "", outputSource: "report", at: 120 })).toEqual([]);
    expect(table.get("tu_1")?.output).toBe("summary");
  });
});

describe("TaskTable runs", () => {
  it("reopens on a started with a new tool use id and ignores late notifications for the previous run", () => {
    const table = tableWith(agentCall("tu_1", 100, true));
    table.apply({ kind: "started", ref: { toolUseId: "tu_1", cliTaskId: "task_a" }, at: 101 });
    table.apply({ kind: "ended", ref: { cliTaskId: "task_a" }, state: "completed", reason: "cli", output: "first", usage: { tokens: 1 }, at: 150 });

    expect(table.apply({ kind: "started", ref: { toolUseId: "tu_2", cliTaskId: "task_a" }, at: 300 })).toStrictEqual([
      { id: "tu_1", cliTaskId: "task_a", kind: "agent", background: true, state: "running", runCount: 2, startedAt: 300 }
    ]);

    expect(
      table.apply({ kind: "ended", ref: { toolUseId: "tu_1", cliTaskId: "task_a" }, state: "completed", reason: "cli", output: "stale", at: 310 })
    ).toEqual([]);
    expect(table.get("tu_1")).toMatchObject({ state: "running", runCount: 2 });

    expect(table.resolve({ toolUseId: "tu_2" })?.id).toBe("tu_1");
    expect(table.get("tu_2")).toBeUndefined();

    table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "failed", reason: "cli", output: "second", at: 400 });
    expect(table.get("tu_1")).toMatchObject({ state: "failed", runCount: 2, startedAt: 300, endedAt: 400, output: "second" });
  });

  it("reopens on a started with a new run id and ignores ended for the previous run id", () => {
    const table = tableWith(agentCall("tu_1", 100, true));
    table.apply({ kind: "started", ref: { toolUseId: "tu_1", runId: "run_1" }, at: 100 });
    table.apply({ kind: "ended", ref: { originId: "tu_1", runId: "run_1" }, state: "completed", reason: "cli", at: 150 });

    expect(table.apply({ kind: "started", ref: { originId: "tu_1", runId: "run_2" }, at: 200 })).toHaveLength(1);
    expect(table.get("tu_1")).toMatchObject({ state: "running", runCount: 2, startedAt: 200 });
    expect(table.resolve({ toolUseId: "tu_1" })?.runCount).toBe(2);

    expect(table.apply({ kind: "ended", ref: { originId: "tu_1", runId: "run_1" }, state: "completed", reason: "cli", at: 210 })).toEqual([]);
    table.apply({ kind: "ended", ref: { originId: "tu_1", runId: "run_2" }, state: "completed", reason: "cli", at: 220 });
    expect(table.get("tu_1")).toMatchObject({ state: "completed", endedAt: 220 });
  });

  it("does not reopen on a started with the same tool use id after a terminal state", () => {
    const table = tableWith(agentCall("tu_1", 100));
    table.apply({ kind: "ended", ref: { toolUseId: "tu_1" }, state: "completed", reason: "tool-result", at: 150 });

    expect(table.apply({ kind: "started", ref: { toolUseId: "tu_1" }, at: 200 })).toEqual([]);
    const changed = table.apply({ kind: "started", ref: { toolUseId: "tu_1", cliTaskId: "task_a" }, background: true, at: 210 });
    expect(changed).toStrictEqual([
      {
        id: "tu_1",
        cliTaskId: "task_a",
        kind: "agent",
        background: true,
        state: "completed",
        endReason: "tool-result",
        runCount: 1,
        startedAt: 100,
        endedAt: 150
      }
    ]);
  });

  it("enriches a running record on started", () => {
    const table = tableWith(agentCall("tu_1", 100));
    expect(table.apply({ kind: "started", ref: { toolUseId: "tu_1", cliTaskId: "task_a" }, taskKind: "shell", background: true, at: 120 })).toStrictEqual([
      { id: "tu_1", cliTaskId: "task_a", kind: "shell", background: true, state: "running", runCount: 1, startedAt: 100 }
    ]);
    expect(table.resolve({ cliTaskId: "task_a" })?.id).toBe("tu_1");
  });
});

describe("TaskTable resolution", () => {
  it("resolves by origin id, then any run tool use id, then cli task id", () => {
    const table = tableWith(agentCall("tu_1", 100), agentCall("tu_9", 100));
    table.apply({ kind: "started", ref: { toolUseId: "tu_1", cliTaskId: "task_a" }, at: 100 });

    expect(table.resolve({ originId: "tu_1" })?.id).toBe("tu_1");
    expect(table.resolve({ toolUseId: "tu_9" })?.id).toBe("tu_9");
    expect(table.resolve({ cliTaskId: "task_a" })?.id).toBe("tu_1");
    expect(table.resolve({ originId: "missing", toolUseId: "tu_9" })?.id).toBe("tu_9");
    expect(table.resolve({ toolUseId: "missing" })).toBeUndefined();
    expect(table.get("task_a")).toBeUndefined();
  });

  it("links a cli task id carried with a resolving tool use id", () => {
    const table = tableWith(agentCall("tu_1", 100, true));
    table.apply({ kind: "background", ref: { toolUseId: "tu_1", cliTaskId: "task_a" }, background: true });
    expect(table.get("tu_1")?.cliTaskId).toBe("task_a");
    expect(table.resolve({ cliTaskId: "task_a" })?.id).toBe("tu_1");
  });
});

describe("TaskTable orphans", () => {
  it("creates an orphan from an unresolvable started", () => {
    const table = new TaskTable();
    expect(table.apply({ kind: "started", ref: { toolUseId: "tu_x", cliTaskId: "task_x", runId: "run_1" }, taskKind: "shell", background: true, at: 50 })).toStrictEqual([
      { id: "tu_x", cliTaskId: "task_x", kind: "shell", background: true, state: "running", runCount: 1, startedAt: 50 }
    ]);
    expect(table.resolve({ cliTaskId: "task_x" })?.id).toBe("tu_x");
  });

  it("creates an orphan from an unresolvable ended keyed by the cli task id", () => {
    const table = new TaskTable();
    expect(table.apply({ kind: "ended", ref: { cliTaskId: "task_y" }, state: "failed", reason: "cli", output: "boom", at: 60 })).toStrictEqual([
      { id: "task_y", cliTaskId: "task_y", kind: "agent", background: false, state: "failed", endReason: "cli", runCount: 1, endedAt: 60, output: "boom" }
    ]);
  });

  it("links the tool use id of a later end to an orphan started without one", () => {
    const table = new TaskTable();
    table.apply({ kind: "started", ref: { cliTaskId: "task_z" }, background: true, at: 10 });
    expect(table.apply({ kind: "ended", ref: { toolUseId: "tu_z", cliTaskId: "task_z" }, state: "completed", reason: "cli", at: 20 })).toStrictEqual([
      { id: "task_z", cliTaskId: "task_z", kind: "agent", background: true, state: "completed", endReason: "cli", runCount: 1, startedAt: 10, endedAt: 20 }
    ]);
    expect(table.resolve({ toolUseId: "tu_z" })?.id).toBe("task_z");
  });

  it("skips orphans without a tool use id or cli task id and ignores unresolvable background", () => {
    const table = new TaskTable();
    expect(table.apply({ kind: "started", ref: { originId: "tu_missing" }, at: 10 })).toEqual([]);
    expect(table.apply({ kind: "ended", ref: { runId: "run_1" }, state: "completed", reason: "cli", at: 10 })).toEqual([]);
    expect(table.apply({ kind: "background", ref: { toolUseId: "tu_missing" }, background: true })).toEqual([]);
    expect(table.snapshots()).toEqual([]);
  });
});

describe("TaskTable background", () => {
  it("sets background and reports only real changes", () => {
    const table = tableWith(agentCall("tu_1", 100));
    expect(table.apply({ kind: "background", ref: { originId: "tu_1" }, background: false })).toEqual([]);
    expect(table.apply({ kind: "background", ref: { originId: "tu_1" }, background: true })).toHaveLength(1);
    expect(table.apply({ kind: "background", ref: { originId: "tu_1" }, background: true })).toEqual([]);
    expect(table.get("tu_1")?.background).toBe(true);
  });
});

describe("TaskTable roster", () => {
  it("closes a previously rostered background task that leaves the roster, then upgrades it on a real end", () => {
    const table = tableWith(agentCall("tu_1", 100, true));
    table.apply({ kind: "started", ref: { toolUseId: "tu_1", cliTaskId: "task_a" }, at: 100 });

    expect(table.apply({ kind: "roster", cliTaskIds: ["task_a"] })).toEqual([]);
    expect(table.apply({ kind: "roster", cliTaskIds: [] })).toStrictEqual([
      { id: "tu_1", cliTaskId: "task_a", kind: "agent", background: true, state: "unknown", endReason: "roster", runCount: 1, startedAt: 100 }
    ]);

    table.apply({ kind: "ended", ref: { cliTaskId: "task_a" }, state: "completed", reason: "cli", at: 500 });
    expect(table.get("tu_1")).toMatchObject({ state: "completed", endReason: "cli", endedAt: 500 });
  });

  it("does not close a task never seen in a roster", () => {
    const table = tableWith(agentCall("tu_1", 100, true));
    table.apply({ kind: "started", ref: { toolUseId: "tu_1", cliTaskId: "task_a" }, at: 100 });

    expect(table.apply({ kind: "roster", cliTaskIds: ["task_b"] })).toEqual([]);
    expect(table.apply({ kind: "roster", cliTaskIds: [] })).toEqual([]);
    expect(table.get("tu_1")?.state).toBe("running");
  });

  it("does not close provisional or foreground tasks", () => {
    const table = tableWith(agentCall("tu_1", 100), agentCall("tu_2", 100, false));
    table.apply({ kind: "started", ref: { toolUseId: "tu_1", cliTaskId: "task_a" }, at: 100 });
    table.apply({ kind: "started", ref: { toolUseId: "tu_2", cliTaskId: "task_b" }, at: 100 });

    table.apply({ kind: "roster", cliTaskIds: ["task_a", "task_b"] });
    expect(table.apply({ kind: "roster", cliTaskIds: [] })).toEqual([]);
    expect(table.snapshots().map((task) => task.state)).toEqual(["running", "running"]);
  });
});

describe("TaskTable liveCount", () => {
  it("counts unmapped roster ids and running non-foreground tasks once", () => {
    const table = tableWith(
      agentCall("tu_bg", 100, true),
      agentCall("tu_provisional", 100),
      agentCall("tu_fg", 100, false),
      agentCall("tu_done", 100, true),
      agentCall("tu_outside", 100, true),
      agentCall("tu_fg_rostered", 100, false)
    );
    table.apply({ kind: "started", ref: { toolUseId: "tu_bg", cliTaskId: "task_bg" }, at: 100 });
    table.apply({ kind: "started", ref: { toolUseId: "tu_done", cliTaskId: "task_done" }, at: 100 });
    table.apply({ kind: "started", ref: { toolUseId: "tu_outside", cliTaskId: "task_outside" }, at: 100 });
    table.apply({ kind: "started", ref: { toolUseId: "tu_fg_rostered", cliTaskId: "task_fg" }, at: 100 });
    table.apply({ kind: "ended", ref: { originId: "tu_done" }, state: "completed", reason: "cli", at: 150 });
    table.apply({ kind: "roster", cliTaskIds: ["task_bg", "task_done", "task_unmapped", "task_fg", "task_unmapped"] });

    expect(table.liveCount()).toBe(4);
  });

  it("is zero for an empty table", () => {
    expect(new TaskTable().liveCount()).toBe(0);
  });
});

describe("TaskTable closeOpen", () => {
  it("closes running tasks that pass the filter", () => {
    const table = tableWith(
      agentCall("tu_agent", 100),
      { kind: "call", toolUseId: "tu_shell", taskKind: "shell", at: 100 },
      agentCall("tu_done", 100)
    );
    table.apply({ kind: "ended", ref: { originId: "tu_done" }, state: "completed", reason: "cli", at: 120 });

    expect(table.closeOpen("interrupted", "interrupt", 200, (task) => task.kind === "agent")).toStrictEqual([
      { id: "tu_agent", kind: "agent", background: false, state: "interrupted", endReason: "interrupt", runCount: 1, startedAt: 100, endedAt: 200 }
    ]);
    expect(table.get("tu_shell")?.state).toBe("running");

    expect(table.closeOpen("unknown", "process-exit", 300).map((task) => task.id)).toEqual(["tu_shell"]);
    expect(table.get("tu_shell")).toMatchObject({ state: "unknown", endReason: "process-exit", endedAt: 300 });
    expect(table.get("tu_done")).toMatchObject({ state: "completed", endedAt: 120 });
    expect(table.closeOpen("unknown", "process-exit", 400)).toEqual([]);
  });
});

describe("TaskTable latestOutput", () => {
  it("returns the output of the most recently started task with output", () => {
    const table = tableWith(agentCall("tu_1", 100), agentCall("tu_2", 300), agentCall("tu_3", 200), agentCall("tu_4", 400));
    expect(table.latestOutput()).toBe("");

    table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "completed", reason: "cli", output: "one", at: 500 });
    table.apply({ kind: "ended", ref: { originId: "tu_3" }, state: "completed", reason: "cli", output: "three", at: 500 });
    expect(table.latestOutput()).toBe("three");

    table.apply({ kind: "ended", ref: { originId: "tu_2" }, state: "completed", reason: "cli", output: "two", at: 500 });
    expect(table.latestOutput()).toBe("two");
  });

  it("breaks startedAt ties by insertion order", () => {
    const table = tableWith(agentCall("tu_1", 100), agentCall("tu_2", 100));
    table.apply({ kind: "ended", ref: { originId: "tu_2" }, state: "completed", reason: "cli", output: "two", at: 500 });
    table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "completed", reason: "cli", output: "one", at: 600 });
    expect(table.latestOutput()).toBe("two");
  });
});

describe("TaskTable snapshots", () => {
  it("lists records in insertion order", () => {
    const table = tableWith(agentCall("tu_b", 100), agentCall("tu_a", 50));
    table.apply({ kind: "started", ref: { toolUseId: "tu_c" }, at: 10 });
    expect(table.snapshots().map((task) => task.id)).toEqual(["tu_b", "tu_a", "tu_c"]);
  });

  it("returns fresh objects that do not leak internal state", () => {
    const table = tableWith(agentCall("tu_1", 100));
    const [changed] = table.apply({ kind: "ended", ref: { originId: "tu_1" }, state: "completed", reason: "cli", usage: { tokens: 1 }, at: 110 });
    changed.state = "running";
    if (changed.usage) changed.usage.tokens = 999;
    const listed = table.snapshots()[0];
    listed.output = "mutated";

    expect(table.get("tu_1")).toStrictEqual({
      id: "tu_1",
      kind: "agent",
      background: false,
      state: "completed",
      endReason: "cli",
      runCount: 1,
      startedAt: 100,
      endedAt: 110,
      usage: { tokens: 1 }
    });
  });

  it("returns an empty list for no-op observations", () => {
    const table = tableWith(agentCall("tu_1", 100, true));
    table.apply({ kind: "started", ref: { toolUseId: "tu_1", cliTaskId: "task_a" }, at: 100 });

    expect(table.apply({ kind: "started", ref: { toolUseId: "tu_1", cliTaskId: "task_a" }, at: 100 })).toEqual([]);
    expect(table.apply(agentCall("tu_1", 100, true))).toEqual([]);
    expect(table.apply({ kind: "background", ref: { cliTaskId: "task_a" }, background: true })).toEqual([]);
    expect(table.apply({ kind: "roster", cliTaskIds: ["task_a"] })).toEqual([]);
  });
});
