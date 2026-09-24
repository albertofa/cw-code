import { describe, expect, it } from "vitest";
import { normalizeTodos, todosFromPlan, todosFromToolCall } from "./todos.js";

describe("normalizeTodos", () => {
  it("maps an opencode payload with priority", () => {
    expect(
      normalizeTodos({
        todos: [
          { content: "Inspect parser", status: "in_progress", priority: "high" },
          { content: "Ship fix", status: "pending", priority: "low" }
        ]
      })
    ).toEqual([
      { content: "Inspect parser", status: "in_progress", priority: "high" },
      { content: "Ship fix", status: "pending", priority: "low" }
    ]);
  });

  it("maps a claude TodoWrite payload and drops activeForm", () => {
    expect(
      normalizeTodos({
        todos: [
          { content: "Write tests", status: "completed", activeForm: "Writing tests" },
          { content: "Run suite", status: "pending", activeForm: "Running suite" }
        ]
      })
    ).toEqual([
      { content: "Write tests", status: "completed" },
      { content: "Run suite", status: "pending" }
    ]);
  });

  it("falls back to label when content is missing or empty", () => {
    expect(
      normalizeTodos({
        todos: [{ label: "From label", status: "pending" }, { content: "   ", label: "Real", status: "pending" }]
      })
    ).toEqual([
      { content: "From label", status: "pending" },
      { content: "Real", status: "pending" }
    ]);
  });

  it("normalizes status case and whitespace", () => {
    expect(
      normalizeTodos({
        todos: [
          { content: "a", status: "  In_Progress  " },
          { content: "b", status: "COMPLETED" },
          { content: "c", status: "Cancelled" }
        ]
      })
    ).toEqual([
      { content: "a", status: "in_progress" },
      { content: "b", status: "completed" },
      { content: "c", status: "cancelled" }
    ]);
  });

  it("falls back to pending for unknown or missing status", () => {
    expect(normalizeTodos({ todos: [{ content: "a", status: "blocked" }, { content: "b" }] })).toEqual([
      { content: "a", status: "pending" },
      { content: "b", status: "pending" }
    ]);
  });

  it("drops invalid priorities", () => {
    expect(normalizeTodos({ todos: [{ content: "a", status: "pending", priority: "urgent" }] })).toEqual([
      { content: "a", status: "pending" }
    ]);
  });

  it("skips items without usable content", () => {
    expect(normalizeTodos({ todos: [{ content: "", status: "pending" }, null, 42, { status: "pending" }] })).toEqual([]);
  });

  it("distinguishes an explicit clear from a non-todo payload", () => {
    expect(normalizeTodos({ todos: [] })).toEqual([]);
    expect(normalizeTodos({})).toBeNull();
    expect(normalizeTodos({ todos: "nope" })).toBeNull();
    expect(normalizeTodos(null)).toBeNull();
    expect(normalizeTodos([])).toBeNull();
    expect(normalizeTodos("todos")).toBeNull();
  });
});

describe("todosFromToolCall", () => {
  const input = { todos: [{ content: "Task", status: "pending" }] };

  it("accepts todowrite and todo names regardless of case or padding", () => {
    expect(todosFromToolCall("todowrite", input)).toEqual([{ content: "Task", status: "pending" }]);
    expect(todosFromToolCall("TodoWrite", input)).toEqual([{ content: "Task", status: "pending" }]);
    expect(todosFromToolCall("  TODO  ", input)).toEqual([{ content: "Task", status: "pending" }]);
  });

  it("gates on the tool name, not the payload shape", () => {
    expect(todosFromToolCall("read", input)).toBeNull();
    expect(todosFromToolCall("", input)).toBeNull();
  });

  it("returns null for a matching name with a non-todo payload", () => {
    expect(todosFromToolCall("TodoWrite", { other: true })).toBeNull();
  });
});

describe("todosFromPlan", () => {
  it("maps a codex plan array directly", () => {
    expect(
      todosFromPlan([
        { step: "Read code", status: "completed" },
        { step: "Patch code", status: "in_progress" }
      ])
    ).toEqual([
      { content: "Read code", status: "completed" },
      { content: "Patch code", status: "in_progress" }
    ]);
  });

  it("unwraps a { plan } envelope", () => {
    expect(todosFromPlan({ plan: [{ step: "Verify", status: "pending" }] })).toEqual([
      { content: "Verify", status: "pending" }
    ]);
  });

  it("treats empty arrays as an explicit clear", () => {
    expect(todosFromPlan([])).toEqual([]);
    expect(todosFromPlan({ plan: [] })).toEqual([]);
  });

  it("returns null for garbage input", () => {
    expect(todosFromPlan(null)).toBeNull();
    expect(todosFromPlan("plan")).toBeNull();
    expect(todosFromPlan({})).toBeNull();
    expect(todosFromPlan({ plan: "nope" })).toBeNull();
  });

  it("skips malformed plan items and unknown statuses fall back to pending", () => {
    expect(todosFromPlan([{ step: "A", status: "weird" }, { status: "pending" }, null, { step: "" }])).toEqual([
      { content: "A", status: "pending" }
    ]);
  });
});
