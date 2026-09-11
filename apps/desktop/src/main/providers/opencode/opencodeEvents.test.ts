import { describe, expect, it } from "vitest";
import { parseOpencodeLine, summarizeRun } from "./opencodeEvents.js";

function freshAcc() {
  return { text: [] as string[], usage: { input: 0, output: 0, reasoning: 0 }, cost: 0, sessionId: "" };
}

describe("parseOpencodeLine", () => {
  it("maps text events to assistant.delta and captures session id", () => {
    const acc = freshAcc();
    const events = parseOpencodeLine(
      JSON.stringify({
        type: "text",
        sessionID: "ses_1",
        part: { type: "text", text: "ok" }
      }),
      "t1",
      acc
    );
    expect(events).toEqual([{ type: "assistant.delta", turnId: "t1", text: "ok" }]);
    expect(acc.sessionId).toBe("ses_1");
  });

  it("accumulates usage from step_finish", () => {
    const acc = freshAcc();
    const events = parseOpencodeLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_1",
        part: {
          type: "step-finish",
          reason: "stop",
          tokens: { total: 9125, input: 8718, output: 11, reasoning: 155 },
          cost: 0
        }
      }),
      "t1",
      acc
    );
    expect(events).toEqual([]);
    expect(acc.usage).toEqual({ input: 8718, output: 11, reasoning: 155 });
  });

  it("maps error events to turn.error", () => {
    const events = parseOpencodeLine(
      JSON.stringify({ type: "error", sessionID: "ses_1", error: { name: "APIError" } }),
      "t1",
      freshAcc()
    );
    expect(events[0]?.type).toBe("turn.error");
  });

  it("emits running tool.call with unwrapped input and callID", () => {
    const events = parseOpencodeLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_1",
        part: {
          id: "prt_1",
          type: "tool",
          tool: "read",
          callID: "call_1",
          state: { status: "running", input: { path: "a.ts" } }
        }
      }),
      "t1",
      freshAcc()
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "tool.call",
      turnId: "t1",
      toolCallId: "call_1",
      name: "read",
      input: { path: "a.ts" }
    });
  });

  it("emits tool.call plus tool.result for completed tools so cards finish", () => {
    const events = parseOpencodeLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_1",
        part: {
          id: "prt_1",
          type: "tool",
          tool: "read",
          callID: "call_1",
          state: { status: "completed", input: { path: "a.ts" }, output: "contents" }
        }
      }),
      "t1",
      freshAcc()
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "tool.call",
      turnId: "t1",
      toolCallId: "call_1",
      name: "read",
      input: { path: "a.ts" }
    });
    expect(events[1]).toEqual({
      type: "tool.result",
      turnId: "t1",
      toolCallId: "call_1",
      output: "contents",
      isError: false
    });
  });

  it("marks error tool state as failed result", () => {
    const events = parseOpencodeLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_1",
        part: {
          id: "prt_2",
          type: "tool",
          tool: "bash",
          callID: "call_2",
          state: { status: "error", input: { command: "ls" }, output: "nope", error: "boom" }
        }
      }),
      "t1",
      freshAcc()
    );
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "tool.result",
      turnId: "t1",
      toolCallId: "call_2",
      output: "nope",
      isError: true
    });
  });
  it("uses the error text when a failed tool has no output", () => {
    const events = parseOpencodeLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_1",
        part: {
          type: "tool",
          tool: "task",
          callID: "call_9",
          state: {
            status: "error",
            input: { description: "Review paths" },
            error: "Subagent failed (task_id: ses_x): The usage limit has been reached"
          }
        }
      }),
      "t1",
      freshAcc()
    );
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "tool.result",
      turnId: "t1",
      toolCallId: "call_9",
      output: "Subagent failed (task_id: ses_x): The usage limit has been reached",
      isError: true
    });
  });

  it("summarizes a run into turn.done", () => {
    const acc = { text: ["ok"], usage: { input: 8718, output: 11, reasoning: 155 }, cost: 0, sessionId: "ses_1" };
    expect(summarizeRun("t1", "local-1", acc)).toEqual({
      type: "turn.done",
      turnId: "t1",
      sessionId: "local-1",
      resumeCursor: "ses_1",
      resultText: "ok",
      inputTokens: 8718,
      outputTokens: 11,
      costUsd: 0,
      numTurns: 1,
      isError: false
    });
  });
});
