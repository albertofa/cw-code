import { describe, expect, it } from "vitest";
import { appendAssistantText, upsertToolCall } from "./chatMessages.js";
import type { ChatMessage } from "../stores/appStore.js";
import type { ToolCallEvent } from "./chatMessages.js";

function toolMessage(id: string, turnId = "t1"): ChatMessage {
  return { id, role: "tool", text: "output", turnId };
}

function call(partial: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return { type: "tool.call", turnId: "t1", toolCallId: "call-1", name: "task", input: {}, ...partial };
}

describe("upsertToolCall", () => {
  it("appends a new tool call with its start time", () => {
    const messages = upsertToolCall([], call({ input: { description: "Review" } }), 1000);
    expect(messages).toEqual([
      {
        id: "call-1",
        role: "tool",
        text: 'task {"description":"Review"}',
        turnId: "t1",
        toolName: "task",
        toolInput: { description: "Review" },
        toolStartedAt: 1000
      }
    ]);
  });

  it("merges a replayed call in place instead of duplicating it", () => {
    const existing: ChatMessage = {
      id: "call-1",
      role: "tool",
      text: "task {}",
      turnId: "t1",
      toolName: "task",
      toolInput: {},
      toolStartedAt: 1000,
      toolOutput: "done",
      toolDone: true,
      toolCompletedAt: 5000
    };
    const messages = upsertToolCall(
      [toolMessage("other"), existing],
      call({ turnId: "t2", input: { description: "Review", subagent_type: "general" } }),
      9000
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      ...existing,
      text: 'task {"description":"Review","subagent_type":"general"}',
      toolInput: { description: "Review", subagent_type: "general" }
    });
  });

  it("keeps the richer input when a replay carries none", () => {
    const existing: ChatMessage = {
      id: "call-1",
      role: "tool",
      text: 'task {"description":"Review"}',
      turnId: "t1",
      toolName: "task",
      toolInput: { description: "Review" },
      toolStartedAt: 1000
    };
    const messages = upsertToolCall([existing], call({ input: null, turnId: "t2" }), 9000);
    expect(messages).toEqual([existing]);
  });

  it("keeps the original turn id when a later turn replays the call", () => {
    const first = upsertToolCall([], call(), 1000);
    const replayed = upsertToolCall(first, call({ turnId: "t2" }), 9000);
    expect(replayed[0].turnId).toBe("t1");
    expect(replayed[0].toolStartedAt).toBe(1000);
  });
});

describe("appendAssistantText", () => {
  it("merges contiguous deltas into a single message", () => {
    let messages: ChatMessage[] = [];
    messages = appendAssistantText(messages, "t1", "Hello ");
    messages = appendAssistantText(messages, "t1", "world");
    expect(messages).toEqual([{ id: "t1-a", role: "assistant", text: "Hello world", turnId: "t1" }]);
  });

  it("appends a distinct id when a tool message splits the text", () => {
    let messages = appendAssistantText([], "t1", "before");
    messages = [...messages, toolMessage("call-1")];
    messages = appendAssistantText(messages, "t1", "after");
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.id)).toEqual(["t1-a", "t1-a2"]);
    expect(assistants.map((m) => m.text)).toEqual(["before", "after"]);
    expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
  });

  it("never reuses an id across many split segments", () => {
    let messages: ChatMessage[] = [];
    const expectedIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      messages = appendAssistantText(messages, "t1", `segment ${i}`);
      expectedIds.push(i === 0 ? "t1-a" : `t1-a${i + 1}`);
      messages = [...messages, toolMessage(`call-${i}`)];
    }
    const assistantIds = messages.filter((m) => m.role === "assistant").map((m) => m.id);
    expect(assistantIds).toEqual(expectedIds);
    expect(new Set(assistantIds).size).toBe(assistantIds.length);
  });

  it("merges in place and keeps the original order", () => {
    const user: ChatMessage = { id: "t1-u", role: "user", text: "hi", turnId: "t1" };
    let messages = appendAssistantText([user, toolMessage("call-1")], "t1", "one");
    messages = appendAssistantText(messages, "t1", " two");
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.id)).toEqual(["t1-u", "call-1", "t1-a"]);
    expect(messages[2].text).toBe("one two");
  });
});
