import { describe, expect, it } from "vitest";
import { parseOpencodeTodosUpdated, toolResultFromState } from "./opencodeEvents.js";

describe("toolResultFromState", () => {
  it("maps string state to a plain result", () => {
    expect(toolResultFromState("contents")).toEqual({ output: "contents", isError: false });
  });

  it("maps completed tool state to call output", () => {
    expect(
      toolResultFromState({ status: "completed", input: { path: "a.ts" }, output: "contents" })
    ).toEqual({ output: "contents", isError: false });
  });

  it("marks error tool state as failed result", () => {
    expect(
      toolResultFromState({ status: "error", input: { command: "ls" }, output: "nope", error: "boom" })
    ).toEqual({ output: "nope", isError: true });
  });

  it("surfaces error payloads when output is empty", () => {
    expect(toolResultFromState({ status: "error", error: "boom" })).toEqual({
      output: "boom",
      isError: true
    });
  });

  it("returns null for running or malformed states", () => {
    expect(toolResultFromState({ status: "running", output: "partial" })).toBeNull();
    expect(toolResultFromState(null)).toBeNull();
    expect(toolResultFromState(42)).toBeNull();
  });
});

describe("parseOpencodeTodosUpdated", () => {
  it("parses a valid todo.updated envelope into normalized items", () => {
    expect(
      parseOpencodeTodosUpdated({
        type: "todo.updated",
        properties: {
          sessionID: "ses_1",
          todos: [
            { content: "Write tests", status: "in_progress", priority: "high" },
            { content: "Ship it", status: "completed" }
          ]
        }
      })
    ).toEqual({
      sessionID: "ses_1",
      todos: [
        { content: "Write tests", status: "in_progress", priority: "high" },
        { content: "Ship it", status: "completed" }
      ]
    });
  });

  it("accepts an empty todos array as an explicit clear", () => {
    expect(
      parseOpencodeTodosUpdated({ type: "todo.updated", properties: { sessionID: "ses_1", todos: [] } })
    ).toEqual({ sessionID: "ses_1", todos: [] });
  });

  it("returns null when properties or sessionID are missing", () => {
    expect(parseOpencodeTodosUpdated({ type: "todo.updated" })).toBeNull();
    expect(parseOpencodeTodosUpdated({ type: "todo.updated", properties: { todos: [] } })).toBeNull();
    expect(parseOpencodeTodosUpdated({ type: "todo.updated", properties: { sessionID: 7, todos: [] } })).toBeNull();
  });

  it("returns null when todos is not an array", () => {
    expect(
      parseOpencodeTodosUpdated({ type: "todo.updated", properties: { sessionID: "ses_1", todos: "nope" } })
    ).toBeNull();
    expect(parseOpencodeTodosUpdated({ type: "todo.updated", properties: { sessionID: "ses_1" } })).toBeNull();
  });

  it("returns null for a different envelope type or a malformed event", () => {
    expect(
      parseOpencodeTodosUpdated({ type: "message.part.delta", properties: { sessionID: "ses_1", todos: [] } })
    ).toBeNull();
    expect(parseOpencodeTodosUpdated(null)).toBeNull();
    expect(parseOpencodeTodosUpdated([])).toBeNull();
  });
});
