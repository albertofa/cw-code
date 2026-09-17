import { describe, expect, it } from "vitest";
import { childModelOf, collectPartTypes, collectTaskParts, diffLiveTools, type LiveMessage, type LiveSeen } from "./opencodeLivePoll.js";

function runningTask(callID: string, description = "Do work"): LiveMessage {
  return {
    info: { id: "m1" },
    parts: [
      {
        type: "tool",
        tool: "task",
        callID,
        state: {
          status: "running",
          input: { description, prompt: "Work hard", subagent_type: "general" }
        }
      }
    ]
  };
}

function completedTask(callID: string, output = "All done"): LiveMessage {
  return {
    info: { id: "m1" },
    parts: [
      {
        type: "tool",
        tool: "task",
        callID,
        state: { status: "completed", input: { description: "Do work" }, output }
      }
    ]
  };
}

function pendingTask(callID: string): LiveMessage {
  return {
    info: { id: "m1" },
    parts: [
      {
        type: "tool",
        tool: "task",
        callID,
        state: { status: "pending", input: {} }
      }
    ]
  };
}

describe("collectPartTypes", () => {
  it("records part ids by type and skips unusable entries", () => {
    const into = new Map<string, string>();
    collectPartTypes(
      [
        {
          info: { id: "m1" },
          parts: [
            { id: "p1", type: "reasoning" },
            { id: "p2", type: "text" },
            { id: "p3" },
            { type: "tool" }
          ]
        }
      ],
      into
    );
    expect([...into]).toEqual([
      ["p1", "reasoning"],
      ["p2", "text"]
    ]);
  });
});

describe("diffLiveTools", () => {
  it("emits a call for a newly seen running tool", () => {
    const seen = new Map<string, LiveSeen>();
    const events = diffLiveTools(seen, [runningTask("call_1")], "t1", null);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "tool.call",
      turnId: "t1",
      toolCallId: "call_1",
      name: "task",
      input: { description: "Do work", prompt: "Work hard", subagent_type: "general" }
    });
  });

  it("emits nothing when the running tool was already seen", () => {
    const seen = new Map<string, LiveSeen>();
    diffLiveTools(seen, [runningTask("call_1")], "t1", null);
    expect(diffLiveTools(seen, [runningTask("call_1")], "t1", null)).toEqual([]);
  });

  it("emits call plus result for a tool seen already completed", () => {
    const seen = new Map<string, LiveSeen>();
    const events = diffLiveTools(seen, [completedTask("call_1")], "t1", null);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("tool.call");
    expect(events[1]).toEqual({
      type: "tool.result",
      turnId: "t1",
      toolCallId: "call_1",
      output: "All done",
      isError: false
    });
    expect(diffLiveTools(seen, [completedTask("call_1")], "t1", null)).toEqual([]);
  });

  it("emits only the result when a running tool completes", () => {
    const seen = new Map<string, LiveSeen>();
    expect(diffLiveTools(seen, [runningTask("call_1")], "t1", null)).toHaveLength(1);
    const events = diffLiveTools(seen, [completedTask("call_1")], "t1", null);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool.result");
  });

  it("surfaces error text for failed tools without output", () => {
    const seen = new Map<string, LiveSeen>();
    const events = diffLiveTools(
      seen,
      [
        {
          info: { id: "m1" },
          parts: [
            {
              type: "tool",
              tool: "task",
              callID: "call_9",
              state: { status: "error", input: { description: "x" }, error: "Subagent failed: boom" }
            }
          ]
        }
      ],
      "t1",
      null
    );
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "tool.result",
      turnId: "t1",
      toolCallId: "call_9",
      output: "Subagent failed: boom",
      isError: true
    });
  });

  it("does not re-emit calls the stdout stream already reported", () => {
    const seen = new Map<string, LiveSeen>([["call_1", { call: true, result: false, input: true }]]);
    const events = diffLiveTools(seen, [runningTask("call_1")], "t1", null);
    expect(events).toEqual([]);
  });

  it("re-emits a pending call once its input arrives", () => {
    const seen = new Map<string, LiveSeen>();
    const first = diffLiveTools(seen, [pendingTask("call_1")], "t1", null);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: "tool.call", toolCallId: "call_1", input: {} });

    const events = diffLiveTools(seen, [runningTask("call_1", "Do work")], "t1", null);
    expect(events).toEqual([
      {
        type: "tool.call",
        turnId: "t1",
        toolCallId: "call_1",
        name: "task",
        input: { description: "Do work", prompt: "Work hard", subagent_type: "general" }
      }
    ]);
    expect(diffLiveTools(seen, [runningTask("call_1", "Do work")], "t1", null)).toEqual([]);
  });

  it("emits a pending call and its result together when input never lands", () => {
    const seen = new Map<string, LiveSeen>();
    const message = pendingTask("call_1");
    const first = diffLiveTools(seen, [message], "t1", null);
    expect(first).toHaveLength(1);

    const completed = completedTask("call_1");
    completed.parts![0]!.state = { status: "completed", input: {}, output: "done" };
    const events = diffLiveTools(seen, [completed], "t1", null);
    expect(events).toEqual([
      { type: "tool.result", turnId: "t1", toolCallId: "call_1", output: "done", isError: false }
    ]);
  });

  it("emits nothing for tools whose message predates the turn", () => {
    const seen = new Map<string, LiveSeen>();
    const old = completedTask("call_old");
    old.info = { id: "m_old" };
    expect(diffLiveTools(seen, [old], "t2", new Set(["m_old"]))).toEqual([]);
  });

  it("emits tools only from messages created after the turn started", () => {
    const seen = new Map<string, LiveSeen>();
    const old = completedTask("call_old");
    old.info = { id: "m_old" };
    const fresh = runningTask("call_new", "New work");
    fresh.info = { id: "m_new" };
    const events = diffLiveTools(seen, [old, fresh], "t2", new Set(["m_old"]));
    expect(events).toEqual([
      {
        type: "tool.call",
        turnId: "t2",
        toolCallId: "call_new",
        name: "task",
        input: { description: "New work", prompt: "Work hard", subagent_type: "general" }
      }
    ]);
  });

  it("stamps the child model on a task result when known", () => {
    const seen = new Map<string, LiveSeen>();
    const events = diffLiveTools(seen, [completedTask("call_1")], "t1", null, undefined, (callId) =>
      callId === "call_1" ? "claude-sonnet-4-5" : undefined
    );
    expect(events[1]).toEqual({
      type: "tool.result",
      turnId: "t1",
      toolCallId: "call_1",
      output: "All done",
      isError: false,
      model: "claude-sonnet-4-5"
    });
  });

  it("stamps the parent tool call on nested subagent tool events", () => {
    const seen = new Map<string, LiveSeen>();
    const messages: LiveMessage[] = [
      {
        info: { id: "child_1" },
        parts: [
          {
            type: "tool",
            tool: "read",
            callID: "child_read",
            state: { status: "completed", input: { file_path: "a.ts" }, output: "file!" }
          }
        ]
      }
    ];
    const events = diffLiveTools(seen, messages, "t1", null, "call_task");
    expect(events).toEqual([
      {
        type: "tool.call",
        turnId: "t1",
        toolCallId: "child_read",
        name: "read",
        input: { file_path: "a.ts" },
        parentToolCallId: "call_task"
      },
      { type: "tool.result", turnId: "t1", toolCallId: "child_read", output: "file!", isError: false }
    ]);
  });
});

describe("childModelOf", () => {
  it("reads the first assistant model and ignores other roles", () => {
    const messages: LiveMessage[] = [
      { info: { id: "u1", role: "user" }, parts: [] },
      { info: { id: "a1", role: "assistant", modelID: "claude-sonnet-4-5", providerID: "anthropic" }, parts: [] },
      { info: { id: "a2", role: "assistant", modelID: "claude-opus-5" }, parts: [] }
    ];
    expect(childModelOf(messages)).toBe("claude-sonnet-4-5");
  });

  it("returns undefined without an assistant model", () => {
    expect(childModelOf([{ info: { id: "a1", role: "assistant" }, parts: [] }])).toBeUndefined();
    expect(childModelOf([])).toBeUndefined();
  });
});

describe("collectTaskParts", () => {
  it("collects task call ids and statuses and ignores other tools", () => {
    const messages: LiveMessage[] = [
      runningTask("call_a", "First"),
      { info: { id: "m2" }, parts: [{ type: "tool", tool: "read", callID: "call_b", state: { status: "running" } }] },
      completedTask("call_c")
    ];
    expect(collectTaskParts(messages)).toEqual([
      { callId: "call_a", status: "running" },
      { callId: "call_c", status: "completed" }
    ]);
  });
});
