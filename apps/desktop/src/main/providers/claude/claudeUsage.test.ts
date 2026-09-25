import { describe, expect, it } from "vitest";
import { claudeTurnUsage, type ClaudeModelUsageSnapshot } from "./claudeUsage.js";

function haikuResult(overrides: Record<string, unknown> = {}) {
  return {
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        inputTokens: 10,
        outputTokens: 42,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 28517,
        webSearchRequests: 0,
        costUSD: 0.057254,
        contextWindow: 200000,
        maxOutputTokens: 32000,
        thinkingTokens: 35,
        canonicalModel: "claude-haiku-4-5",
        provider: "firstParty",
        costBasis: "list"
      }
    },
    usage: {
      iterations: [
        { input_tokens: 10, output_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 28517 }
      ]
    },
    ...overrides
  };
}

describe("claudeTurnUsage", () => {
  it("returns the full cumulative values as the delta for the first turn of a process", () => {
    const { usage, context, next } = claudeTurnUsage({}, haikuResult());
    expect(usage).toEqual([
      {
        model: "claude-haiku-4-5-20251001",
        inputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 28517,
        outputTokens: 42,
        reasoningTokens: 35,
        costUsd: 0.057254
      }
    ]);
    expect(context).toEqual({ usedTokens: 10 + 0 + 28517 + 42, windowTokens: 200000 });
    expect(next).toEqual({
      "claude-haiku-4-5-20251001": {
        inputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 28517,
        outputTokens: 42,
        reasoningTokens: 35,
        costUsd: 0.057254
      }
    });
  });

  it("computes the second turn's delta against the previous cumulative snapshot", () => {
    const first = claudeTurnUsage({}, haikuResult());
    const second = claudeTurnUsage(
      first.next,
      haikuResult({
        modelUsage: {
          "claude-haiku-4-5-20251001": {
            inputTokens: 20,
            outputTokens: 88,
            cacheReadInputTokens: 28517,
            cacheCreationInputTokens: 29687,
            webSearchRequests: 0,
            costUSD: 0.0626857,
            contextWindow: 200000,
            maxOutputTokens: 32000,
            thinkingTokens: 74,
            canonicalModel: "claude-haiku-4-5",
            provider: "firstParty",
            costBasis: "list"
          }
        },
        usage: {
          iterations: [
            { input_tokens: 10, output_tokens: 46, cache_read_input_tokens: 28517, cache_creation_input_tokens: 1170 }
          ]
        }
      })
    );
    expect(second.usage).toEqual([
      {
        model: "claude-haiku-4-5-20251001",
        inputTokens: 10,
        cacheReadTokens: 28517,
        cacheWriteTokens: 1170,
        outputTokens: 46,
        reasoningTokens: 39,
        costUsd: expect.closeTo(0.0054317, 6)
      }
    ]);
    expect(second.context).toEqual({ usedTokens: 10 + 28517 + 1170 + 46, windowTokens: 200000 });
  });

  it("produces two entries when a subagent uses a second model", () => {
    const result = {
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 100,
          outputTokens: 200,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.5,
          contextWindow: 200000,
          thinkingTokens: 10
        },
        "claude-haiku-4-5-20251001": {
          inputTokens: 5,
          outputTokens: 500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
          contextWindow: 200000,
          thinkingTokens: 0
        }
      },
      usage: {
        iterations: [{ input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]
      }
    };
    const { usage, context } = claudeTurnUsage({}, result);
    expect(usage).toHaveLength(2);
    expect(usage.map((u) => u.model).sort()).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5"]);
    expect(context?.windowTokens).toBe(200000);
  });

  it("returns an empty usage array when the result has no modelUsage", () => {
    const { usage, context, next } = claudeTurnUsage({}, { session_id: "s1" });
    expect(usage).toEqual([]);
    expect(context).toBeUndefined();
    expect(next).toEqual({});
  });

  it("drops models whose delta is entirely zero", () => {
    const prev: ClaudeModelUsageSnapshot = {
      "claude-sonnet-5": {
        inputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 200,
        reasoningTokens: 10,
        costUsd: 0.5
      }
    };
    const result = {
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 100,
          outputTokens: 200,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.5,
          contextWindow: 200000,
          thinkingTokens: 10
        }
      },
      usage: { iterations: [] }
    };
    const { usage, context } = claudeTurnUsage(prev, result);
    expect(usage).toEqual([]);
    expect(context).toBeUndefined();
  });

  it("omits context when the winning model has no contextWindow", () => {
    const result = {
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.1,
          thinkingTokens: 0
        }
      },
      usage: {
        iterations: [{ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]
      }
    };
    const { context } = claudeTurnUsage({}, result);
    expect(context).toBeUndefined();
  });

  it("omits context when there are no usage iterations", () => {
    const result = haikuResult({ usage: { iterations: [] } });
    const { context } = claudeTurnUsage({}, result);
    expect(context).toBeUndefined();
  });

  it("keeps the previous snapshot and reports no usage when modelUsage is missing, null, or not an object", () => {
    const prev: ClaudeModelUsageSnapshot = {
      "claude-sonnet-5": {
        inputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 200,
        reasoningTokens: 10,
        costUsd: 0.5
      }
    };
    for (const result of [{ session_id: "s1" }, { modelUsage: null }, { modelUsage: "not-an-object" }, { modelUsage: [] }]) {
      const { usage, context, next } = claudeTurnUsage(prev, result);
      expect(usage).toEqual([]);
      expect(context).toBeUndefined();
      expect(next).toBe(prev);
    }
  });

  it("takes windowTokens from the main model, even when it isn't the largest-output entry", () => {
    const result = {
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 100,
          outputTokens: 500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.5,
          contextWindow: 200000,
          thinkingTokens: 0
        },
        "claude-haiku-4-5-20251001": {
          inputTokens: 5,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
          contextWindow: 50000,
          thinkingTokens: 0
        }
      },
      usage: {
        iterations: [{ input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]
      }
    };
    const { context } = claudeTurnUsage({}, result, "claude-haiku-4-5");
    expect(context?.windowTokens).toBe(50000);
  });

  it("matches the main model to a dated modelUsage key by prefix", () => {
    const result = haikuResult();
    const { context } = claudeTurnUsage({}, result, "claude-haiku-4-5");
    expect(context?.windowTokens).toBe(200000);
  });

  it("falls back to the largest-output model when the main model has no matching key", () => {
    const result = {
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 100,
          outputTokens: 500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.5,
          contextWindow: 200000,
          thinkingTokens: 0
        }
      },
      usage: {
        iterations: [{ input_tokens: 100, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]
      }
    };
    const { context } = claudeTurnUsage({}, result, "claude-opus-4");
    expect(context?.windowTokens).toBe(200000);
  });

  it("treats the current cumulative values as the delta when a counter resets below the previous snapshot", () => {
    const prev: ClaudeModelUsageSnapshot = {
      "claude-haiku-4-5-20251001": {
        inputTokens: 500,
        cacheReadTokens: 1000,
        cacheWriteTokens: 2000,
        outputTokens: 900,
        reasoningTokens: 100,
        costUsd: 0.9
      }
    };
    const result = haikuResult({
      modelUsage: {
        "claude-haiku-4-5-20251001": {
          inputTokens: 10,
          outputTokens: 42,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 28517,
          costUSD: 0.057254,
          contextWindow: 200000,
          thinkingTokens: 35
        }
      }
    });
    const { usage, next } = claudeTurnUsage(prev, result);
    expect(usage).toEqual([
      {
        model: "claude-haiku-4-5-20251001",
        inputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 28517,
        outputTokens: 42,
        reasoningTokens: 35,
        costUsd: 0.057254
      }
    ]);
    expect(next["claude-haiku-4-5-20251001"]).toEqual({
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 28517,
      outputTokens: 42,
      reasoningTokens: 35,
      costUsd: 0.057254
    });
  });
});
