import { describe, expect, it } from "vitest";
import type { PrWorkflow } from "@cw-code/contracts";
import { createWorkflow, deleteWorkflow, duplicateWorkflow, insertAtCursor, moveWorkflow, newWorkflowId, resetWorkflowTo } from "./prWorkflowEditor.js";

function workflow(overrides: Partial<PrWorkflow> = {}): PrWorkflow {
  return {
    id: "review",
    label: "Review",
    description: "Read the diff.",
    icon: "eye",
    builtIn: true,
    enabled: true,
    suggestWhen: ["review-requested"],
    workspace: "checkout",
    startPrompt: "start",
    updatePrompt: "update",
    ...overrides
  };
}

describe("newWorkflowId", () => {
  it("starts at custom-1 when there are no custom workflows", () => {
    expect(newWorkflowId([workflow()])).toBe("custom-1");
  });

  it("picks one past the highest existing custom id", () => {
    const existing = [workflow(), workflow({ id: "custom-1", builtIn: false }), workflow({ id: "custom-3", builtIn: false })];
    expect(newWorkflowId(existing)).toBe("custom-4");
  });
});

describe("createWorkflow", () => {
  it("appends a blank, enabled, custom workflow with a unique id", () => {
    const existing = [workflow({ id: "custom-1", builtIn: false })];
    const next = createWorkflow(existing);
    expect(next).toHaveLength(2);
    const added = next[1];
    expect(added.id).toBe("custom-2");
    expect(added.builtIn).toBe(false);
    expect(added.enabled).toBe(true);
    expect(added.suggestWhen).toEqual([]);
  });
});

describe("duplicateWorkflow", () => {
  it("inserts a non-built-in copy right after the source", () => {
    const existing = [workflow({ id: "a" }), workflow({ id: "b" })];
    const next = duplicateWorkflow(existing, "a");
    expect(next.map((w) => w.id)).toEqual(["a", "custom-1", "b"]);
    expect(next[1].builtIn).toBe(false);
    expect(next[1].label).toBe("Review copy");
  });

  it("is a no-op when the source id is not found", () => {
    const existing = [workflow({ id: "a" })];
    expect(duplicateWorkflow(existing, "missing")).toBe(existing);
  });
});

describe("moveWorkflow", () => {
  it("swaps with the previous entry when moving up", () => {
    const existing = [workflow({ id: "a" }), workflow({ id: "b" }), workflow({ id: "c" })];
    expect(moveWorkflow(existing, "b", "up").map((w) => w.id)).toEqual(["b", "a", "c"]);
  });

  it("swaps with the next entry when moving down", () => {
    const existing = [workflow({ id: "a" }), workflow({ id: "b" }), workflow({ id: "c" })];
    expect(moveWorkflow(existing, "b", "down").map((w) => w.id)).toEqual(["a", "c", "b"]);
  });

  it("is a no-op at the top or bottom boundary", () => {
    const existing = [workflow({ id: "a" }), workflow({ id: "b" })];
    expect(moveWorkflow(existing, "a", "up")).toBe(existing);
    expect(moveWorkflow(existing, "b", "down")).toBe(existing);
  });
});

describe("deleteWorkflow", () => {
  it("removes a custom workflow", () => {
    const existing = [workflow({ id: "custom-1", builtIn: false }), workflow({ id: "review" })];
    expect(deleteWorkflow(existing, "custom-1").map((w) => w.id)).toEqual(["review"]);
  });

  it("is a no-op for a built-in workflow", () => {
    const existing = [workflow({ id: "review" })];
    expect(deleteWorkflow(existing, "review")).toBe(existing);
  });
});

describe("resetWorkflowTo", () => {
  it("replaces a built-in entry's content with its default at the same index", () => {
    const existing = [
      workflow({ id: "custom-1", builtIn: false }),
      workflow({ id: "review", label: "Renamed", description: "Edited", startPrompt: "edited" })
    ];
    const defaults = [workflow({ id: "review" })];
    const next = resetWorkflowTo(existing, "review", defaults);
    expect(next.map((w) => w.id)).toEqual(["custom-1", "review"]);
    expect(next[1].label).toBe("Review");
    expect(next[1].description).toBe("Read the diff.");
    expect(next[1].startPrompt).toBe("start");
  });

  it("preserves the current entry's enabled value instead of the default's", () => {
    const existing = [workflow({ id: "review", enabled: false })];
    const defaults = [workflow({ id: "review", enabled: true })];
    expect(resetWorkflowTo(existing, "review", defaults)[0].enabled).toBe(false);
  });

  it("is a no-op for a custom workflow", () => {
    const existing = [workflow({ id: "custom-1", builtIn: false })];
    expect(resetWorkflowTo(existing, "custom-1", [workflow({ id: "custom-1", builtIn: false })])).toBe(existing);
  });

  it("is a no-op when the id is not found", () => {
    const existing = [workflow({ id: "review" })];
    expect(resetWorkflowTo(existing, "missing", [workflow({ id: "review" })])).toBe(existing);
  });

  it("is a no-op when no default exists for the id", () => {
    const existing = [workflow({ id: "review" })];
    expect(resetWorkflowTo(existing, "review", [])).toBe(existing);
  });
});

describe("insertAtCursor", () => {
  it("inserts at the cursor position", () => {
    expect(insertAtCursor("hello world", "{{x}}", 5, 5)).toEqual({ value: "hello{{x}} world", cursor: 10 });
  });

  it("replaces a selection", () => {
    expect(insertAtCursor("hello world", "{{x}}", 6, 11)).toEqual({ value: "hello {{x}}", cursor: 11 });
  });

  it("clamps out-of-range positions to the text bounds", () => {
    expect(insertAtCursor("hi", "!", 10, 20)).toEqual({ value: "hi!", cursor: 3 });
  });
});
