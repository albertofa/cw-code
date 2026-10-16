import { describe, expect, it } from "vitest";
import type { PrWorkflowHarness } from "@cw-code/contracts";
import type { ModelOption, PermissionOption } from "../cw.js";
import { harnessSummary, INHERITED_HARNESS, resolveWorkflowHarness, type WorkflowHarnessContext } from "./workflowHarness.js";

const MODELS: ModelOption[] = [
  { id: "claude-opus-5", label: "Opus 5", source: "curated" },
  { id: "claude-sonnet-5", label: "Sonnet 5", source: "curated" }
];

const PERMISSIONS: PermissionOption[] = [
  { id: "manual", label: "Supervised", description: "", native: true },
  { id: "auto", label: "Auto", description: "", native: true },
  { id: "bypassPermissions", label: "Full Access", description: "", native: false }
];

function context(overrides: Partial<WorkflowHarnessContext> = {}): WorkflowHarnessContext {
  return {
    composerDriver: "claude",
    pendingPrefs: { effort: "low", permissionMode: "manual" },
    defaultModel: "claude-sonnet-5",
    recentModels: [],
    models: MODELS,
    permissions: PERMISSIONS,
    ...overrides
  };
}

function config(overrides: Partial<PrWorkflowHarness> = {}): PrWorkflowHarness {
  return { ...INHERITED_HARNESS, ...overrides };
}

describe("resolveWorkflowHarness", () => {
  it("follows the composer when the workflow sets nothing", () => {
    expect(resolveWorkflowHarness(INHERITED_HARNESS, context())).toEqual({
      driver: "claude",
      model: "claude-sonnet-5",
      effort: "low",
      permissionMode: "manual"
    });
  });

  it("uses every value the workflow sets", () => {
    const resolved = resolveWorkflowHarness(
      config({ driver: "codex", model: "gpt-5", effort: "xhigh", permissionMode: "bypassPermissions" }),
      context({ models: [] })
    );
    expect(resolved).toEqual({ driver: "codex", model: "gpt-5", effort: "xhigh", permissionMode: "bypassPermissions" });
  });

  it("follows the composer's staged harness when the workflow sets none", () => {
    expect(resolveWorkflowHarness(INHERITED_HARNESS, context({ composerDriver: "codex" })).driver).toBe("codex");
    expect(resolveWorkflowHarness(config({ driver: "claude" }), context({ composerDriver: "codex" })).driver).toBe("claude");
  });

  it("ignores a model when the workflow follows the composer harness", () => {
    expect(resolveWorkflowHarness(config({ model: "claude-opus-5" }), context()).model).toBe("claude-sonnet-5");
  });

  it("falls back from a permission mode the harness does not offer", () => {
    expect(resolveWorkflowHarness(config({ permissionMode: "acceptEdits" }), context()).permissionMode).toBe("manual");
    expect(resolveWorkflowHarness(config({ permissionMode: "acceptEdits" }), context({ permissions: [] })).permissionMode).toBe("acceptEdits");
  });

  it("lowers an effort the opencode model cannot run", () => {
    const models: ModelOption[] = [{ id: "openai/gpt-5", label: "GPT-5", source: "live", variants: ["low", "medium"] }];
    const resolved = resolveWorkflowHarness(config({ driver: "opencode", model: "openai/gpt-5", effort: "max" }), context({ models }));
    expect(resolved.effort).toBe("medium");
  });
});

describe("harnessSummary", () => {
  it("labels each part and marks the inherited ones", () => {
    const harness = config({ driver: "claude", model: "claude-opus-5" });
    const summary = harnessSummary(harness, resolveWorkflowHarness(harness, context()), { models: MODELS, permissions: PERMISSIONS });
    expect(summary.parts).toEqual([
      { key: "driver", label: "Claude", inherited: false },
      { key: "model", label: "Opus 5", inherited: false },
      { key: "effort", label: "Low effort", inherited: true },
      { key: "permission", label: "Supervised", inherited: true }
    ]);
    expect(summary.title).toContain("Low effort, Supervised");
  });

  it("says so when the workflow sets everything", () => {
    const harness = config({ driver: "claude", model: "claude-opus-5", effort: "high", permissionMode: "auto" });
    const summary = harnessSummary(harness, resolveWorkflowHarness(harness, context()), { models: MODELS, permissions: PERMISSIONS });
    expect(summary.parts.every((part) => !part.inherited)).toBe(true);
    expect(summary.title).toBe("All set by this workflow");
  });
});
