import { describe, expect, it } from "vitest";
import type { ModelOption } from "../cw.js";
import { CLAUDE_CURATED_MODELS as DRIVER_CURATED_MODELS } from "../../../main/providers/claude/ClaudeCliDriver.js";
import {
  CLAUDE_CURATED_MODELS,
  contextWindowLabel,
  defaultModelPatch,
  effortLabel,
  effortOptionsFor,
  fallbackEffort,
  filterModels,
  groupModels,
  hasContextSuffix,
  hasModelDetail,
  modelDetailRows,
  pickInitialModel,
  latestRecentModel,
  pickerSections,
  providerDriver,
  providerLabel,
  stripContextSuffix,
  withContextSuffix
} from "./modelMenus.js";

function opt(id: string, extra: Partial<ModelOption> = {}): ModelOption {
  return { id, label: id, source: "live", ...extra };
}

describe("CLAUDE_CURATED_MODELS", () => {
  it("matches the list the Claude driver reports", () => {
    expect(CLAUDE_CURATED_MODELS).toEqual(DRIVER_CURATED_MODELS);
  });
});

describe("context suffix helpers", () => {
  it("detects the 1M suffix case-insensitively and only at the end", () => {
    expect(hasContextSuffix("claude-opus-5-5[1m]")).toBe(true);
    expect(hasContextSuffix("claude-opus-5-5[1M]")).toBe(true);
    expect(hasContextSuffix("claude-opus-5-5")).toBe(false);
    expect(hasContextSuffix("[1m]-opus")).toBe(false);
  });

  it("adds the suffix for 1M", () => {
    expect(withContextSuffix("claude-opus-5-5", true)).toBe("claude-opus-5-5[1m]");
  });

  it("does not stack the suffix", () => {
    expect(withContextSuffix("fable[1m]", true)).toBe("fable[1m]");
    expect(withContextSuffix("fable[1M]", true)).toBe("fable[1m]");
  });

  it("removes the suffix for 200K", () => {
    expect(withContextSuffix("fable[1m]", false)).toBe("fable");
    expect(withContextSuffix("fable", false)).toBe("fable");
  });

  it("strips the suffix", () => {
    expect(stripContextSuffix("sonnet[1m]")).toBe("sonnet");
    expect(stripContextSuffix("sonnet")).toBe("sonnet");
  });

  it("labels the two windows", () => {
    expect(contextWindowLabel(false)).toBe("200K");
    expect(contextWindowLabel(true)).toBe("1M");
  });
});

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

describe("defaultModelPatch", () => {
  it("targets the harness's own default setting", () => {
    expect(defaultModelPatch("claude", "sonnet")).toEqual({ claudeDefaultModel: "sonnet" });
    expect(defaultModelPatch("codex", "gpt")).toEqual({ codexDefaultModel: "gpt" });
    expect(defaultModelPatch("opencode", "p/m")).toEqual({ opencodeDefaultModel: "p/m" });
  });

  it("clears with an empty id", () => {
    expect(defaultModelPatch("opencode", "")).toEqual({ opencodeDefaultModel: "" });
  });
});

describe("effortLabel", () => {
  it("names every level", () => {
    expect(
      (["minimal", "low", "medium", "high", "xhigh", "max"] as const).map(effortLabel)
    ).toEqual(["Minimal", "Low", "Medium", "High", "Extra high", "Max"]);
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

describe("groupModels", () => {
  it("groups Claude and Codex under one harness group", () => {
    expect(groupModels("claude", [opt("a"), opt("b")])).toEqual([{ id: "claude", label: "Claude Code", models: [opt("a"), opt("b")] }]);
    expect(groupModels("codex", [opt("a")])[0].label).toBe("Codex");
    expect(groupModels("claude", [])).toEqual([]);
  });

  it("groups OpenCode by provider in alphabetical order", () => {
    const groups = groupModels("opencode", [opt("zed/m2"), opt("alpha/m1"), opt("zed/m1"), opt("plain")]);
    expect(groups.map((g) => g.id)).toEqual(["alpha", "other", "zed"]);
    expect(groups[2].models.map((m) => m.id)).toEqual(["zed/m2", "zed/m1"]);
  });

  it("maps providers to the harness icon that owns them", () => {
    expect(providerDriver("anthropic")).toBe("claude");
    expect(providerDriver("openai")).toBe("codex");
    expect(providerDriver("openrouter")).toBe("opencode");
  });

  it("formats provider labels", () => {
    expect(providerLabel("openrouter")).toBe("OpenRouter");
    expect(providerLabel("anthropic")).toBe("Anthropic");
    expect(providerLabel("github-copilot")).toBe("Github Copilot");
  });
});

describe("filterModels", () => {
  const models = [opt("anthropic/claude-haiku", { label: "Claude Haiku" }), opt("openai/gpt-5", { label: "GPT 5" })];

  it("returns everything for a blank query", () => {
    expect(filterModels(models, "  ")).toBe(models);
  });

  it("matches label or id, ignoring case", () => {
    expect(filterModels(models, "HAIKU").map((m) => m.id)).toEqual(["anthropic/claude-haiku"]);
    expect(filterModels(models, "openai").map((m) => m.id)).toEqual(["openai/gpt-5"]);
    expect(filterModels(models, "nothing")).toEqual([]);
  });
});

describe("pickerSections", () => {
  const models = [opt("anthropic/a", { label: "Alpha" }), opt("anthropic/b", { label: "Beta" }), opt("openai/c", { label: "Gamma" })];

  it("makes one group per OpenCode provider", () => {
    const sections = pickerSections("opencode", models, "");
    expect(sections.map((s) => s.id)).toEqual(["anthropic", "openai"]);
    expect(sections.map((s) => s.icon)).toEqual(["claude", "codex"]);
  });

  it("uses one harness group for Claude and Codex", () => {
    const sections = pickerSections("claude", [opt("x"), opt("y")], "");
    expect(sections.map((s) => [s.label, s.icon])).toEqual([["Claude Code", "claude"]]);
  });

  it("filters groups while searching", () => {
    expect(pickerSections("opencode", models, "gam").map((s) => s.id)).toEqual(["openai"]);
  });

  it("returns nothing when the search matches nothing", () => {
    expect(pickerSections("opencode", models, "zzz")).toEqual([]);
  });
});

describe("latestRecentModel", () => {
  const models = [opt("a"), opt("b")];

  it("returns the most recent model still listed", () => {
    expect(latestRecentModel(models, ["gone", "b", "a"])).toBe("b");
  });

  it("returns null when no recent is listed", () => {
    expect(latestRecentModel(models, ["gone"])).toBeNull();
    expect(latestRecentModel(models, [])).toBeNull();
  });
});

describe("model detail", () => {
  it("only offers a card when meta or context exists", () => {
    expect(hasModelDetail(opt("a"))).toBe(false);
    expect(hasModelDetail(opt("a", { contextWindow: 200000 }))).toBe(true);
    expect(hasModelDetail(opt("a", { meta: {} }))).toBe(true);
  });

  it("lists every reported field", () => {
    const rows = modelDetailRows(
      opt("anthropic/claude-opus-5-5", {
        contextWindow: 1_000_000,
        variants: ["default", "high", "max"],
        meta: {
          costInputPerM: 5,
          costOutputPerM: 25,
          capabilities: ["Tool calling", "Reasoning"],
          input: ["text", "image"],
          output: ["text"]
        }
      }),
      "OpenCode"
    );
    expect(rows).toEqual([
      { label: "Model", value: "anthropic/claude-opus-5-5", mono: true },
      { label: "Context", value: "1M tokens" },
      { label: "Capabilities", value: "Tool calling, Reasoning" },
      { label: "Input", value: "text, image" },
      { label: "Output", value: "text" },
      { label: "Cost ($/1M tokens)", value: "In $5.00 · Out $25.00" },
      { label: "Variants", value: "default · high · max" },
      { label: "Source", value: "Live from OpenCode" }
    ]);
  });

  it("skips fields the CLI did not report", () => {
    const rows = modelDetailRows(opt("a/b", { contextWindow: 200000, meta: { costOutputPerM: 1.5 } }), "OpenCode");
    expect(rows.map((r) => r.label)).toEqual(["Model", "Context", "Cost ($/1M tokens)", "Source"]);
    expect(rows[2].value).toBe("Out $1.50");
  });
});
