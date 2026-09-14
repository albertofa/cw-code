import { describe, expect, it } from "vitest";
import { appendAssistantText } from "./chatMessages.js";
import type { ChatMessage } from "../stores/appStore.js";

function toolMessage(id: string, turnId = "t1"): ChatMessage {
  return { id, role: "tool", text: "output", turnId };
}

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
