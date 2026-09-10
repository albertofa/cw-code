import { describe, expect, it } from "vitest";
import { attributeClaudeSubagentEvent, parseStreamLine } from "./claudeStreamParser.js";

describe("parseStreamLine", () => {
  it("maps text deltas to assistant.delta", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "hello " } }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "assistant.delta", turnId: "t1", text: "hello " }
    ]);
  });

  it("maps assistant tool_use blocks to tool.call", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: { path: "a.ts" } }] }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "tool.call", turnId: "t1", toolCallId: "tu1", name: "Read", input: { path: "a.ts" } }
    ]);
  });

  it("maps user tool results to tool.result", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ tool_use_id: "tu1", content: "file contents" }] }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "tool.result", turnId: "t1", toolCallId: "tu1", output: "file contents", isError: false }
    ]);
  });

  it("emits turn metadata on result", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "sess-1",
      total_cost_usd: 0.02,
      usage: { input_tokens: 100, output_tokens: 20 },
      num_turns: 2,
      is_error: false
    });
    let captured: Parameters<Parameters<typeof parseStreamLine>[3]>[0] | null = null;
    const events = parseStreamLine(line, "t1", "s1", (info) => {
      captured = info;
    });
    expect(events).toEqual([]);
    expect(captured).toEqual({
      resumeCursor: "sess-1",
      resultText: "done",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.02,
      numTurns: 2,
      isError: false
    });
  });

  it("passes through non-JSON lines as text", () => {
    expect(parseStreamLine("plain text", "t1", "s1", () => {})).toEqual([
      { type: "assistant.delta", turnId: "t1", text: "plain text" }
    ]);
  });
});

describe("attributeClaudeSubagentEvent", () => {
  it("links SendMessage calls after a Task launch result", () => {
    const agentByCall = new Map<string, string>();
    attributeClaudeSubagentEvent(
      {
        type: "tool.result",
        turnId: "t1",
        toolCallId: "task-call",
        output: "Async agent launched successfully.\nagentId: a202cd0fd545a319e",
        isError: false
      },
      agentByCall
    );
    expect(
      attributeClaudeSubagentEvent(
        {
          type: "tool.call",
          turnId: "t1",
          toolCallId: "send-call",
          name: "SendMessage",
          input: { to: "a202cd0fd545a319e", message: "Check this" }
        },
        agentByCall
      )
    ).toEqual({
      type: "tool.call",
      turnId: "t1",
      toolCallId: "send-call",
      name: "SendMessage",
      input: { to: "a202cd0fd545a319e", message: "Check this" },
      parentToolCallId: "task-call"
    });
  });

  it("leaves unrelated and unknown-recipient calls unchanged", () => {
    const agentByCall = new Map([["task-call", "a202cd0fd545a319e"]]);
    const read = {
      type: "tool.call" as const,
      turnId: "t1",
      toolCallId: "read-call",
      name: "Read",
      input: { path: "a.ts" }
    };
    const send = {
      type: "tool.call" as const,
      turnId: "t1",
      toolCallId: "send-call",
      name: "SendMessage",
      input: { to: "unknown" }
    };
    expect(attributeClaudeSubagentEvent(read, agentByCall)).toBe(read);
    expect(attributeClaudeSubagentEvent(send, agentByCall)).toBe(send);
  });
});
