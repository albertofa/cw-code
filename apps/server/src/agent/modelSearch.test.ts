import { describe, expect, test } from "bun:test";
import { MODEL_MATCH_LIMIT, modelSearchTokens, parseModelQuery, rankModelMatches } from "./modelSearch.js";

const CLAUDE = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-opus-4-5", label: "Opus 4.5" },
  { id: "claude-opus-4-1", label: "Opus 4.1" },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }
];

const CODEX = [
  { id: "gpt-5", label: "GPT-5" },
  { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
  { id: "gpt-5-codex", label: "GPT-5 Codex" },
  { id: "gpt-4.1", label: "GPT-4.1" }
];

const OPENCODE = [
  { id: "openai/gpt-5", label: "GPT-5" },
  { id: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5" },
  { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "moonshotai/kimi-k2", label: "Kimi K2" }
];

const ids = (models: Array<{ id: string }>): string[] => models.map((model) => model.id);

describe("modelSearchTokens", () => {
  test("splits separators and digit groups", () => {
    expect(modelSearchTokens("Opus4.5")).toEqual(["opus", "4", "5"]);
    expect(modelSearchTokens("anthropic/claude-sonnet_4:5")).toEqual(["anthropic", "claude", "sonnet", "4", "5"]);
    expect(modelSearchTokens("claude-opus-5-5[1m]")).toEqual(["claude", "opus", "5", "5", "1", "m"]);
  });
});

describe("parseModelQuery", () => {
  test("reports an effort word and keeps it as an optional term", () => {
    expect(parseModelQuery("gpt 5 codex high")).toEqual({ terms: ["gpt", "5", "codex", "high"], harnesses: ["codex"], effort: "high" });
    expect(parseModelQuery("opus x-high")).toEqual({ terms: ["opus"], harnesses: [], effort: "xhigh" });
    expect(parseModelQuery("opus extra high").effort).toBe("xhigh");
  });

  test("collects harness words outside provider-prefixed ids", () => {
    expect(parseModelQuery("opencode claude sonnet").harnesses).toEqual(["opencode", "claude"]);
    expect(parseModelQuery("kimi").harnesses).toEqual([]);
    expect(parseModelQuery("anthropic/claude-opus-4-5").harnesses).toEqual([]);
    expect(parseModelQuery("openai/gpt-5-codex").harnesses).toEqual([]);
  });
});

describe("rankModelMatches", () => {
  test("maps a plain-text Claude model to its id", () => {
    expect(rankModelMatches(CLAUDE, "opus 4.5")).toEqual([{ id: "claude-opus-4-5", label: "Opus 4.5" }]);
    expect(ids(rankModelMatches(CLAUDE, "Opus4.5"))).toEqual(["claude-opus-4-5"]);
  });

  test("puts the exact name before longer names that share its tokens", () => {
    expect(ids(rankModelMatches(CLAUDE, "opus 5"))).toEqual(["claude-opus-5", "claude-opus-5-5", "claude-opus-4-5"]);
  });

  test("matches numbers only as whole tokens", () => {
    expect(ids(rankModelMatches(CLAUDE, "haiku 4.5"))).toEqual(["claude-haiku-4-5-20251001"]);
    expect(rankModelMatches(CLAUDE, "opus 2025")).toEqual([]);
  });

  test("ranks a harness word as a tiebreak instead of a requirement", () => {
    expect(ids(rankModelMatches(CODEX, "gpt 5 codex"))).toEqual(["gpt-5-codex", "gpt-5", "gpt-5.1-codex-max"]);
  });

  test("matches provider-prefixed opencode ids by their model name", () => {
    expect(ids(rankModelMatches(OPENCODE, "claude sonnet 4.5"))).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(ids(rankModelMatches(OPENCODE, "anthropic/claude-opus-4-5"))).toEqual(["anthropic/claude-opus-4-5"]);
    expect(ids(rankModelMatches(OPENCODE, "kimi"))).toEqual(["moonshotai/kimi-k2"]);
  });

  test("ranks token-prefix matches before substring matches", () => {
    const models = [
      { id: "provider/supersonnet", label: "Super" },
      { id: "anthropic/sonnet-x", label: "Sonnet X" }
    ];
    expect(ids(rankModelMatches(models, "sonnet"))).toEqual(["anthropic/sonnet-x", "provider/supersonnet"]);
  });

  test("does not require the effort word to match", () => {
    expect(ids(rankModelMatches(CODEX, "gpt 5 codex high"))[0]).toBe("gpt-5-codex");
  });

  test("prefers a model whose id contains the effort word", () => {
    expect(ids(rankModelMatches(CODEX, "gpt 5.1 codex max"))).toEqual(["gpt-5.1-codex-max"]);
    const models = [
      { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
      { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" }
    ];
    expect(ids(rankModelMatches(models, "gpt 5.1 codex max"))).toEqual(["gpt-5.1-codex-max", "gpt-5.1-codex"]);
    expect(parseModelQuery("gpt 5.1 codex max").effort).toBe("max");
  });

  test("ranks digits in the query order above the same digits in another order", () => {
    const models = [
      { id: "claude-opus-5-4", label: "claude-opus-5-4" },
      { id: "claude-opus-4-5", label: "claude-opus-4-5" }
    ];
    expect(ids(rankModelMatches(models, "opus 4.5"))).toEqual(["claude-opus-4-5", "claude-opus-5-4"]);
  });

  test("returns nothing when a term matches no model", () => {
    expect(rankModelMatches(CLAUDE, "gemini")).toEqual([]);
    expect(rankModelMatches(CLAUDE, "opus 3")).toEqual([]);
  });

  test("returns at most the match limit", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({ id: `vendor/model-${index}`, label: `Model ${index}` }));
    expect(rankModelMatches(many, "model")).toHaveLength(MODEL_MATCH_LIMIT);
  });
});
