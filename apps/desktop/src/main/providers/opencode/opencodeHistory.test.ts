import { describe, expect, it } from "vitest";
import { mapOpencodeMessages } from "./opencodeHistory.js";
import { mergeToolPairs } from "../../../renderer/src/components/toolSummaries.js";
import type { ChatMessage } from "../../../renderer/src/stores/appStore.js";

describe("mapOpencodeMessages", () => {
  it("maps user text and assistant text with roles", () => {
    const out = mapOpencodeMessages([
      { info: { id: "m1", role: "user" }, parts: [{ id: "p1", type: "text", text: "hi" }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ id: "p2", type: "text", text: "hello" }] }
    ]);
    expect(out).toEqual([
      { id: "p1", role: "user", text: "hi", turnId: "m1" },
      { id: "p2", role: "assistant", text: "hello", turnId: "m2" }
    ]);
  });

  it("maps tool parts to call cards with outputs", () => {
    const out = mapOpencodeMessages([
      {
        info: { id: "m3", role: "assistant" },
        parts: [
          {
            id: "p3",
            type: "tool",
            tool: "read",
            callID: "call_1",
            state: { status: "completed", input: { path: "a.ts" }, output: "contents" }
          }
        ]
      }
    ]);
    expect(out).toEqual([
      { id: "call_1", role: "tool", text: 'read {"path":"a.ts"}', turnId: "m3", toolName: "read" },
      { id: "call_1-r", role: "tool", text: "contents", turnId: "m3", toolName: "read", isError: false }
    ]);
  });

  it("surfaces error text for failed task parts without output", () => {
    const out = mapOpencodeMessages([
      {
        info: { id: "m9", role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "task",
            callID: "call_9",
            state: {
              status: "error",
              input: { description: "Review paths" },
              error: "Subagent failed: usage limit reached"
            }
          }
        ]
      }
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      id: "call_9-r",
      role: "tool",
      text: "Subagent failed: usage limit reached",
      turnId: "m9",
      toolName: "task",
      isError: true
    });
  });

  it("skips step bookkeeping parts", () => {
    const out = mapOpencodeMessages([
      { info: { id: "m4", role: "assistant" }, parts: [{ type: "step-start" }, { type: "step-finish" }] }
    ]);
    expect(out).toEqual([]);
  });

  it("attaches normalized todos to todowrite call messages", () => {
    const out = mapOpencodeMessages([
      {
        info: { id: "m10", role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "todowrite",
            callID: "call_todo",
            state: {
              status: "completed",
              input: {
                todos: [
                  { content: "Write tests", status: "in_progress", priority: "high" },
                  { content: "Ship it", status: "completed" }
                ]
              },
              output: "ok"
            }
          }
        ]
      }
    ]);
    expect(out[0]).toMatchObject({
      id: "call_todo",
      toolName: "todowrite",
      todos: [
        { content: "Write tests", status: "in_progress", priority: "high" },
        { content: "Ship it", status: "completed" }
      ]
    });
  });

  it("keeps todos complete when the input JSON is truncated for text", () => {
    const longContent = "x".repeat(5000);
    const out = mapOpencodeMessages([
      {
        info: { id: "m11", role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "todowrite",
            callID: "call_todo_long",
            state: { status: "completed", input: { todos: [{ content: longContent, status: "pending" }] } }
          }
        ]
      }
    ]);
    expect(out[0].text.length).toBeLessThan(2100);
    expect(out[0].todos).toEqual([{ content: longContent, status: "pending" }]);
  });

  it("tool call cards merge their paired results so they resolve to done", () => {
    const history = mapOpencodeMessages([
      {
        info: { id: "m3", role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "webfetch",
            callID: "call_mix",
            state: { status: "completed", input: { url: "https://example.com" }, output: "page body" }
          }
        ]
      }
    ]) as unknown as ChatMessage[];
    const merged = mergeToolPairs(history);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "call_mix",
      toolName: "webfetch",
      toolDone: true,
      toolOutput: "page body"
    });
  });
});
