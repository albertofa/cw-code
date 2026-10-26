import { describe, expect, it } from "bun:test";
import type { ModelOption, PermissionOption, PrWorkflowHarness } from "@cw-code/contracts";
import {
  effortLabel,
  effortOptionsFor,
  fallbackEffort,
  fallbackPermission,
  harnessSummary,
  INHERITED_HARNESS,
  pickInitialModel,
  resolveWorkflowHarness,
  type WorkflowHarnessContext
} from "./workflowHarness.js";

const MODELS: ModelOption[] = [
  { id: "claude-opus-5", label: "Opus 5", source: "curated" },
  { id: "claude-sonnet-5", label: "Sonnet 5", source: "curated" }
];

const PERMISSIONS: PermissionOption[] = [
  { id: "manual", label: "Supervised", description: "", native: true },
  { id: "auto", label: "Auto", description: "", native: true },
  { id: "bypassPermissions", label: "Full Access", description: "", native: false }
];

function offered(...ids: PermissionOption["id"][]): PermissionOption[] {
  return ids.map((id) => ({ id, label: id, description: "", native: true }));
}

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

  it("never falls back to a more permissive mode than the one asked for", () => {
    expect(fallbackPermission("auto", offered("bypassPermissions", "manual", "acceptEdits"))).toBe("acceptEdits");
    expect(fallbackPermission("acceptEdits", offered("bypassPermissions", "auto", "manual"))).toBe("manual");
    expect(fallbackPermission("bypassPermissions", offered("auto", "manual"))).toBe("auto");
  });

  it("takes the least permissive mode offered when none is below the one asked for", () => {
    expect(fallbackPermission("manual", offered("bypassPermissions", "auto"))).toBe("auto");
  });

  it("lowers an effort the opencode model cannot run", () => {
    const models: ModelOption[] = [{ id: "openai/gpt-5", label: "GPT-5", source: "live", variants: ["low", "medium"] }];
    const resolved = resolveWorkflowHarness(config({ driver: "opencode", model: "openai/gpt-5", effort: "max" }), context({ models }));
    expect(resolved.effort).toBe("medium");
  });
});

describe("harnessSummary", () => {
  function summarize(harness: PrWorkflowHarness, ctx = context()) {
    return harnessSummary(harness, resolveWorkflowHarness(harness, ctx), ctx);
  }

  it("labels each part and marks the inherited ones", () => {
    const summary = summarize(config({ driver: "claude", model: "claude-opus-5" }));
    expect(summary.parts).toEqual([
      { key: "driver", label: "Claude", source: "workflow" },
      { key: "model", label: "Opus 5", source: "workflow" },
      { key: "effort", label: "Low effort", source: "composer" },
      { key: "permission", label: "Supervised", source: "composer" }
    ]);
    expect(summary.title).toContain("Low effort, Supervised");
  });

  it("says so when the workflow sets everything", () => {
    const summary = summarize(config({ driver: "claude", model: "claude-opus-5", effort: "high", permissionMode: "auto" }));
    expect(summary.parts.every((part) => part.source === "workflow")).toBe(true);
    expect(summary.title).toBe("All set by this workflow");
  });

  it("marks a workflow value the harness does not support as a fallback", () => {
    const summary = summarize(config({ driver: "claude", model: "claude-opus-5", effort: "high", permissionMode: "acceptEdits" }));
    expect(summary.parts.find((part) => part.key === "permission")).toEqual({ key: "permission", label: "Supervised", source: "fallback" });
    expect(summary.title).toBe("Not supported here, falling back to: Supervised");
  });

  it("marks an inherited composer value the harness does not support as a fallback", () => {
    const summary = summarize(config({ driver: "claude", model: "claude-opus-5", effort: "high" }), context({ pendingPrefs: { permissionMode: "acceptEdits" } }));
    expect(summary.parts.find((part) => part.key === "permission")).toEqual({ key: "permission", label: "Supervised", source: "fallback" });
    expect(summary.title).toBe("Not supported here, falling back to: Supervised");
  });
});

function opt(id: string, extra: Partial<ModelOption> = {}): ModelOption {
  return { id, label: id, source: "live", ...extra };
}

describe("pickInitialModel", () => {
  const models = [opt("a"), opt("b"), opt("c")];

  it("prefers the harness default when it is listed", () => {
    expect(pickInitialModel(models, "c", ["b"])).toBe("c");
  });

  it("falls back to the most recent listed model when the default is missing", () => {
    expect(pickInitialModel(models, "gone", ["gone", "b", "a"])).toBe("b");
    expect(pickInitialModel(models, "", ["b"])).toBe("b");
  });

  it("falls back to the first model when nothing else matches", () => {
    expect(pickInitialModel(models, "", [])).toBe("a");
    expect(pickInitialModel(models, "gone", ["also-gone"])).toBe("a");
  });

  it("returns null for an empty list", () => {
    expect(pickInitialModel([], "a", ["a"])).toBeNull();
  });
});

describe("effortLabel", () => {
  it("names every level", () => {
    expect((["minimal", "low", "medium", "high", "xhigh", "max"] as const).map(effortLabel)).toEqual([
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max"
    ]);
  });
});

describe("effortOptionsFor", () => {
  it("offers every level outside OpenCode", () => {
    expect(effortOptionsFor("claude", [], "x")).toHaveLength(6);
    expect(effortOptionsFor("codex", [opt("x", { variants: [] })], "x")).toHaveLength(6);
  });

  it("limits OpenCode to the model's variants", () => {
    const models = [opt("p/m", { variants: ["low", "high"] })];
    expect(effortOptionsFor("opencode", models, "p/m").map((o) => o.id)).toEqual(["low", "high"]);
  });

  it("maps the balanced variant to medium and falls back to high without variants", () => {
    expect(effortOptionsFor("opencode", [opt("p/m", { variants: ["balanced"] })], "p/m").map((o) => o.id)).toEqual(["medium"]);
    expect(effortOptionsFor("opencode", [opt("p/m", { variants: [] })], "p/m").map((o) => o.id)).toEqual(["high"]);
  });

  it("offers every level for unknown OpenCode models", () => {
    expect(effortOptionsFor("opencode", [], "p/unknown")).toHaveLength(6);
    expect(effortOptionsFor("opencode", [opt("p/m")], "p/m")).toHaveLength(6);
  });
});

describe("fallbackEffort", () => {
  const available = effortOptionsFor("opencode", [opt("p/m", { variants: ["low", "high"] })], "p/m");

  it("keeps a supported level", () => {
    expect(fallbackEffort("high", available)).toBe("high");
  });

  it("steps down to the nearest lower level", () => {
    expect(fallbackEffort("max", available)).toBe("high");
    expect(fallbackEffort("medium", available)).toBe("low");
  });

  it("takes the first level when none is lower", () => {
    expect(fallbackEffort("minimal", available)).toBe("low");
  });

  it("keeps the current level when nothing is available", () => {
    const none = effortOptionsFor("opencode", [opt("p/m", { variants: ["fast"] })], "p/m");
    expect(none).toEqual([]);
    expect(fallbackEffort("high", none)).toBe("high");
    expect(fallbackEffort("medium", [])).toBe("medium");
  });
});
