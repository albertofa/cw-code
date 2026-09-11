import { describe, expect, it } from "vitest";
import { diffLiveTools, type LiveMessage, type LiveSeen } from "./opencodeLivePoll.js";

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

describe("diffLiveTools", () => {
  it("emits a call for a newly seen running tool", () => {
    const seen = new Map<string, LiveSeen>();
    const events = diffLiveTools(seen, [runningTask("call_1")], "t1");
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
    diffLiveTools(seen, [runningTask("call_1")], "t1");
    expect(diffLiveTools(seen, [runningTask("call_1")], "t1")).toEqual([]);
  });

  it("emits call plus result for a tool seen already completed", () => {
    const seen = new Map<string, LiveSeen>();
    const events = diffLiveTools(seen, [completedTask("call_1")], "t1");
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("tool.call");
    expect(events[1]).toEqual({
      type: "tool.result",
      turnId: "t1",
      toolCallId: "call_1",
      output: "All done",
      isError: false
    });
    expect(diffLiveTools(seen, [completedTask("call_1")], "t1")).toEqual([]);
  });

  it("emits only the result when a running tool completes", () => {
    const seen = new Map<string, LiveSeen>();
    expect(diffLiveTools(seen, [runningTask("call_1")], "t1")).toHaveLength(1);
    const events = diffLiveTools(seen, [completedTask("call_1")], "t1");
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
      "t1"
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
    const seen = new Map<string, LiveSeen>([["call_1", { call: true, result: false }]]);
    const events = diffLiveTools(seen, [runningTask("call_1")], "t1");
    expect(events).toEqual([]);
  });
});
