import { describe, expect, it } from "vitest";
import { labelForModel, mapEffortToVariant, OPENCODE_CURATED_MODELS, parseOpencodeModels, parseOpencodeVerboseModels, prettyModelLabel, resolveOpencodeVariant } from "./opencodeModels.js";

describe("parseOpencodeModels", () => {
  it("parses provider/model lines, dedups and sorts", () => {
    const out = parseOpencodeModels("anthropic/claude-sonnet-4-5\nopenai/gpt-5.2\n\nanthropic/claude-sonnet-4-5\nnot-a-model\n");
    expect(out.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5.2"]);
    expect(out.every((m) => m.source === "live")).toBe(true);
  });

  it("ignores blank lines", () => {
    expect(parseOpencodeModels("\n  \n")).toEqual([]);
  });

  it("labels known ids with their curated names", () => {
    const out = parseOpencodeModels("anthropic/claude-sonnet-4-5\n");
    expect(out[0]).toMatchObject({ id: "anthropic/claude-sonnet-4-5", label: "Sonnet 4.5" });
  });
});

describe("labelForModel / prettyModelLabel", () => {
  it("prefers curated labels", () => {
    expect(labelForModel("anthropic/claude-opus-5")).toBe("Opus 5");
  });

  it("derives readable labels from unknown ids", () => {
    expect(prettyModelLabel("google/gemini-2-5-flash")).toBe("Gemini 2.5 Flash");
    expect(prettyModelLabel("openai/gpt-5-mini")).toBe("GPT 5 Mini");
    expect(prettyModelLabel("x/model")).toBe("Model");
  });
});

describe("mapEffortToVariant", () => {
  it("maps effort levels to variants", () => {
    expect(mapEffortToVariant("minimal")).toBe("minimal");
    expect(mapEffortToVariant("low")).toBe("low");
    expect(mapEffortToVariant("medium")).toBe("medium");
    expect(mapEffortToVariant("high")).toBe("high");
    expect(mapEffortToVariant("xhigh")).toBe("xhigh");
    expect(mapEffortToVariant("max")).toBe("max");
  });

  it("maps the legacy balanced effort to medium", () => {
    expect(mapEffortToVariant("balanced")).toBe("medium");
  });

  it("returns undefined for unknown efforts instead of inventing a variant", () => {
    expect(mapEffortToVariant("unknown")).toBeUndefined();
  });

  it("falls back to the closest available variant", () => {
    expect(mapEffortToVariant("max", ["minimal", "low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(mapEffortToVariant("minimal", ["low", "medium"])).toBe("low");
    expect(mapEffortToVariant("low", ["minimal", "low", "medium", "high", "xhigh"])).toBe("low");
  });

  it("returns undefined when the model has no ranked variants", () => {
    expect(mapEffortToVariant("high", [])).toBeUndefined();
    expect(mapEffortToVariant("high", ["none", "thinking"])).toBeUndefined();
  });
});

describe("resolveOpencodeVariant", () => {
  it("prefers an explicit variant known to the model", () => {
    expect(resolveOpencodeVariant(["low", "xhigh"], "max", "xhigh")).toBe("xhigh");
  });

  it("falls back to effort when the explicit variant is unknown", () => {
    expect(resolveOpencodeVariant(["low", "xhigh"], "max", "max")).toBe("xhigh");
  });
});

describe("parseOpencodeVerboseModels", () => {
  it("attaches variant names to each model", () => {
    const stdout = [
      "opencode-go/muse-spark-1.3-contributor",
      '{ "variants": { "minimal": {}, "low": {}, "medium": {}, "high": {}, "xhigh": {} } }',
      "opencode-go/kimi-k3",
      '{ "variants": { "max": {} } }',
      "opencode-go/glm-5.1",
      '{ "variants": {} }'
    ].join("\n");
    const out = parseOpencodeVerboseModels(stdout);
    expect(out.find((m) => m.id === "opencode-go/muse-spark-1.3-contributor")?.variants).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
    ]);
    expect(out.find((m) => m.id === "opencode-go/kimi-k3")?.variants).toEqual(["max"]);
    expect(out.find((m) => m.id === "opencode-go/glm-5.1")?.variants).toEqual([]);
  });
});

describe("OPENCODE_CURATED_MODELS", () => {
  it("has a non-empty fallback", () => {
    expect(OPENCODE_CURATED_MODELS.length).toBeGreaterThan(0);
  });
});
