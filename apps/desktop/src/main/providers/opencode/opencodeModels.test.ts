import { describe, expect, it } from "vitest";
import { labelForModel, mapEffortToVariant, OPENCODE_CURATED_MODELS, parseOpencodeModels, prettyModelLabel } from "./opencodeModels.js";

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
    expect(mapEffortToVariant("low")).toBe("minimal");
    expect(mapEffortToVariant("medium")).toBe("balanced");
    expect(mapEffortToVariant("high")).toBe("high");
    expect(mapEffortToVariant("xhigh")).toBe("xhigh");
    expect(mapEffortToVariant("max")).toBe("max");
  });

  it("falls back to balanced", () => {
    expect(mapEffortToVariant("unknown")).toBe("balanced");
  });
});

describe("OPENCODE_CURATED_MODELS", () => {
  it("has a non-empty fallback", () => {
    expect(OPENCODE_CURATED_MODELS.length).toBeGreaterThan(0);
  });
});
