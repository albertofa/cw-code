import { describe, expect, it } from "bun:test";
import type { PrWorkflow } from "@cw-code/contracts";
import {
  changeWorkflowTarget,
  CONDITIONS_BY_TARGET,
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  groupWorkflowsByTarget,
  insertAtCursor,
  moveWorkflow,
  moveWorkflowTo,
  newWorkflowId,
  resetWorkflowTemplateTo,
  resetWorkflowTo,
  templateVarIssues,
  workflowsValidationError,
  workflowValidationError
} from "./prWorkflowEditor.js";

function workflow(overrides: Partial<PrWorkflow> = {}): PrWorkflow {
  return {
    id: "review",
    label: "Review",
    description: "Read the diff.",
    icon: "eye",
    builtIn: true,
    enabled: true,
    target: "pr",
    suggestWhen: ["review-requested"],
    workspace: "checkout",
    harness: { driver: null, model: "", effort: null, permissionMode: null },
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

describe("moveWorkflowTo", () => {
  const existing = [workflow({ id: "a" }), workflow({ id: "b" }), workflow({ id: "c" }), workflow({ id: "d" })];

  it("moves an entry down into the target's slot", () => {
    expect(moveWorkflowTo(existing, "a", "c").map((w) => w.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an entry up into the target's slot", () => {
    expect(moveWorkflowTo(existing, "d", "b").map((w) => w.id)).toEqual(["a", "d", "b", "c"]);
  });

  it("is a no-op for the same entry or an unknown id", () => {
    expect(moveWorkflowTo(existing, "b", "b")).toBe(existing);
    expect(moveWorkflowTo(existing, "missing", "b")).toBe(existing);
    expect(moveWorkflowTo(existing, "b", "missing")).toBe(existing);
  });

  it("refuses to move an entry onto another target's workflow", () => {
    const mixed = [workflow({ id: "a" }), workflow({ id: "x", target: "issue" }), workflow({ id: "b" })];
    expect(moveWorkflowTo(mixed, "a", "x")).toBe(mixed);
    expect(moveWorkflowTo(mixed, "b", "a").map((w) => w.id)).toEqual(["b", "a", "x"]);
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

describe("resetWorkflowTemplateTo", () => {
  it("restores only the given template and keeps every other edit", () => {
    const existing = [
      workflow({ id: "review", label: "Renamed", workspace: "worktree", enabled: false, startPrompt: "edited start", updatePrompt: "edited update" })
    ];
    const defaults = [workflow({ id: "review" })];
    expect(resetWorkflowTemplateTo(existing, "review", "startPrompt", defaults)[0]).toEqual({ ...existing[0], startPrompt: "start" });
    expect(resetWorkflowTemplateTo(existing, "review", "updatePrompt", defaults)[0]).toEqual({ ...existing[0], updatePrompt: "update" });
  });

  it("is a no-op for a custom workflow or a missing default", () => {
    const custom = [workflow({ id: "custom-1", builtIn: false, startPrompt: "x" })];
    expect(resetWorkflowTemplateTo(custom, "custom-1", "startPrompt", [workflow({ id: "custom-1" })])).toBe(custom);
    const builtIn = [workflow({ id: "review", startPrompt: "x" })];
    expect(resetWorkflowTemplateTo(builtIn, "review", "startPrompt", [])).toBe(builtIn);
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

describe("createWorkflow target", () => {
  it("defaults to pr and accepts another target", () => {
    expect(createWorkflow([])[0].target).toBe("pr");
    expect(createWorkflow([], "issue")[0].target).toBe("issue");
  });
});

describe("moveWorkflow across targets", () => {
  it("swaps with the nearest neighbor of the same target", () => {
    const existing = [
      workflow({ id: "a", target: "pr" }),
      workflow({ id: "x", target: "issue" }),
      workflow({ id: "b", target: "pr" })
    ];
    expect(moveWorkflow(existing, "b", "up").map((w) => w.id)).toEqual(["b", "x", "a"]);
    expect(moveWorkflow(existing, "x", "up")).toBe(existing);
    expect(moveWorkflow(existing, "x", "down")).toBe(existing);
  });
});

describe("groupWorkflowsByTarget", () => {
  it("groups in pr, issue, run order and skips empty groups", () => {
    const groups = groupWorkflowsByTarget([
      workflow({ id: "r", target: "run" }),
      workflow({ id: "p1", target: "pr" }),
      workflow({ id: "p2", target: "pr" })
    ]);
    expect(groups.map((g) => [g.target, g.workflows.map((w) => w.id)])).toEqual([
      ["pr", ["p1", "p2"]],
      ["run", ["r"]]
    ]);
  });
});

describe("changeWorkflowTarget", () => {
  it("drops conditions that do not apply to the new target", () => {
    const next = changeWorkflowTarget(workflow({ suggestWhen: ["review-requested", "draft"] }), "issue");
    expect(next.target).toBe("issue");
    expect(next.suggestWhen).toEqual([]);
  });

  it("keeps conditions that apply to the new target", () => {
    const next = changeWorkflowTarget(workflow({ target: "issue", suggestWhen: ["issue-bug"] }), "issue");
    expect(next.suggestWhen).toEqual(["issue-bug"]);
  });

  it("replaces the linked workspace outside pr targets", () => {
    expect(changeWorkflowTarget(workflow({ workspace: "linked" }), "run").workspace).toBe("worktree");
    expect(changeWorkflowTarget(workflow({ workspace: "linked" }), "pr").workspace).toBe("linked");
  });
});

describe("CONDITIONS_BY_TARGET", () => {
  it("offers the issue and run conditions only on their targets", () => {
    expect(CONDITIONS_BY_TARGET.issue).toEqual(["issue-assigned", "issue-bug"]);
    expect(CONDITIONS_BY_TARGET.run).toEqual(["run-failed"]);
    expect(CONDITIONS_BY_TARGET.pr).not.toContain("issue-bug");
  });
});

describe("template variable validation", () => {
  it("accepts variables that belong to the workflow's target", () => {
    const issue = workflow({ target: "issue", startPrompt: "{{issue.title}} {{ attribution }}", updatePrompt: "{{issue.delta}}" });
    expect(workflowValidationError(issue)).toBeNull();
  });

  it("rejects a variable from another target's namespace", () => {
    const issue = workflow({ label: "Mixed", target: "issue", startPrompt: "{{pr.number}}", updatePrompt: "{{run.id}} {{checks.summary}} {{issue.delta}}" });
    expect(templateVarIssues(issue)).toEqual({
      startPrompt: { foreign: ["pr.number"], unknown: [] },
      updatePrompt: { foreign: ["run.id", "checks.summary"], unknown: [] }
    });
    const error = workflowValidationError(issue);
    expect(error).toContain("{{pr.number}}");
    expect(error).toContain("{{run.id}}");
    expect(error).toContain("issues");
  });

  it("rejects issue and run variables on a pr workflow", () => {
    expect(workflowValidationError(workflow({ startPrompt: "{{issue.title}}" }))).toContain("{{issue.title}}");
    expect(workflowValidationError(workflow({ updatePrompt: "{{run.id}}" }))).toContain("{{run.id}}");
  });

  it("allows variables outside every target namespace and reports them as unknown", () => {
    const issue = workflow({ target: "issue", startPrompt: "{{ github.sha }} {{foo}} {{issue.nope}}" });
    expect(workflowValidationError(issue)).toBeNull();
    expect(templateVarIssues(issue).startPrompt).toEqual({ foreign: [], unknown: ["github.sha", "foo", "issue.nope"] });
  });

  it("allows an unknown variable inside the workflow's own namespace", () => {
    expect(workflowValidationError(workflow({ startPrompt: "{{pr.nope}}" }))).toBeNull();
  });

  it("only validates workflows changed in the draft", () => {
    const original = [workflow({ id: "legacy", target: "issue", startPrompt: "{{pr.number}}" }), workflow({ id: "ok" })];
    expect(workflowsValidationError(original, original)).toBeNull();
    const edited = [original[0], workflow({ id: "ok", target: "run", startPrompt: "{{pr.title}}" })];
    expect(workflowsValidationError(edited, original)).toEqual({
      workflowId: "ok",
      message: expect.stringContaining("{{pr.title}}")
    });
  });

  it("validates a new workflow and a workflow whose target changed", () => {
    const original = [workflow({ id: "a", startPrompt: "{{pr.number}}" })];
    const retargeted = [{ ...original[0], target: "issue" as const }];
    expect(workflowsValidationError(retargeted, original)?.workflowId).toBe("a");
    expect(workflowsValidationError([...original, workflow({ id: "b", target: "run", startPrompt: "{{issue.title}}" })], original)?.workflowId).toBe("b");
  });
});
