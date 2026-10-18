import { describe, expect, it } from "vitest";
import { mapV2Models } from "./opencodeV2Models.js";

describe("mapV2Models", () => {
  it("maps /api/model into picker options with variants, context and cost", () => {
    const models = mapV2Models({
      location: { directory: "C:\\p" },
      data: [
        {
          id: "deepseek-v4.1-flash-free",
          modelID: "deepseek-v4.1-flash-free",
          providerID: "opencode",
          name: "DeepSeek V4.1 Flash Free",
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          variants: [{ id: "low", settings: {} }, { id: "high", settings: {} }],
          cost: [{ input: 0.5, output: 2, cache: { read: 0, write: 0 } }],
          status: "active",
          enabled: true,
          limit: { context: 200000, output: 32000 }
        },
        { id: "big-pickle", providerID: "opencode", name: "Big Pickle", variants: [], cost: [], enabled: true, limit: { context: 100 } },
        { id: "off", providerID: "opencode", enabled: false },
        { id: "", providerID: "opencode" }
      ]
    });
    expect(models).toEqual([
      { id: "opencode/big-pickle", label: "Big Pickle", source: "live", variants: [], contextWindow: 100 },
      {
        id: "opencode/deepseek-v4.1-flash-free",
        label: "DeepSeek V4.1 Flash Free",
        source: "live",
        variants: ["low", "high"],
        contextWindow: 200000,
        meta: { costInputPerM: 0.5, costOutputPerM: 2, capabilities: ["Tool calling", "Attachments"], input: ["text", "image"], output: ["text"] }
      }
    ]);
  });

  it("returns nothing for a payload without data", () => {
    expect(mapV2Models({})).toEqual([]);
  });
});
