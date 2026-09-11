import { describe, expect, it } from "vitest";
import { mapOpencodeMessages } from "./opencodeHistory.js";

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
});
