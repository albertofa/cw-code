import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOpencodeModelsCache,
  decodeOpencodeModelsCache,
  initOpencodeModelsCache,
  labelForModel,
  listOpencodeModels,
  mapEffortToVariant,
  OPENCODE_CURATED_MODELS,
  OPENCODE_MODELS_CACHE_TTL_MS,
  parseOpencodeModels,
  parseOpencodeVerboseModels,
  prettyModelLabel,
  resolveOpencodeVariant,
  type OpencodeModelsQuery
} from "./opencodeModels.js";

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

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("listOpencodeModels cache", () => {
  beforeEach(() => clearOpencodeModelsCache());
  afterEach(() => clearOpencodeModelsCache());

  it("serves the cached list without re-querying", async () => {
    let calls = 0;
    const query: OpencodeModelsQuery = async (_binary, args) => {
      calls += 1;
      return args.includes("--verbose") ? "" : "anthropic/claude-sonnet-4-5\n";
    };
    const first = await listOpencodeModels("C:\\one", "opencode.cmd", query);
    const second = await listOpencodeModels("C:\\two", "opencode.cmd", query);
    expect(first.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(second).toBe(first);
    expect(calls).toBe(2);
  });

  it("shares one query between concurrent cold calls", async () => {
    let calls = 0;
    const query: OpencodeModelsQuery = async (_binary, args) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return args.includes("--verbose") ? "" : "openai/gpt-5.2\n";
    };
    const [a, b, c] = await Promise.all([
      listOpencodeModels("one", "opencode", query),
      listOpencodeModels("two", "opencode", query),
      listOpencodeModels("three", "opencode", query)
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls).toBe(2);
  });

  it("returns the stale list immediately and refreshes in the background", async () => {
    const base = 1_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(base);
    let current = "provider/alpha";
    const query: OpencodeModelsQuery = async (_binary, args) =>
      args.includes("--verbose") ? "" : `${current}\n`;
    const first = await listOpencodeModels("one", "opencode", query);
    expect(first.map((m) => m.id)).toEqual(["provider/alpha"]);
    current = "provider/beta";
    now.mockReturnValue(base + OPENCODE_MODELS_CACHE_TTL_MS + 1);
    const stale = await listOpencodeModels("one", "opencode", query);
    expect(stale.map((m) => m.id)).toEqual(["provider/alpha"]);
    await flush();
    const fresh = await listOpencodeModels("one", "opencode", query);
    expect(fresh.map((m) => m.id)).toEqual(["provider/beta"]);
    now.mockRestore();
  });

  it("does not cache a failed query", async () => {
    let calls = 0;
    const query: OpencodeModelsQuery = async () => {
      calls += 1;
      throw new Error("spawn failed");
    };
    const first = await listOpencodeModels("one", "opencode", query);
    expect(first).toBe(OPENCODE_CURATED_MODELS);
    const second = await listOpencodeModels("one", "opencode", query);
    expect(second).toBe(OPENCODE_CURATED_MODELS);
    expect(calls).toBe(4);
  });
});

describe("opencode models disk cache", () => {
  beforeEach(() => clearOpencodeModelsCache());
  afterEach(() => clearOpencodeModelsCache());

  it("persists the live list and seeds it on the next startup", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cw-opencode-models-")), "opencode-models.json");
    initOpencodeModelsCache(file);
    const live = await listOpencodeModels(
      "one",
      "opencode.cmd",
      async (_binary, args) => (args.includes("--verbose") ? "" : "openai/gpt-5.2\n")
    );
    expect(existsSync(file)).toBe(true);
    clearOpencodeModelsCache();
    initOpencodeModelsCache(file);
    let calls = 0;
    const offline: OpencodeModelsQuery = async () => {
      calls += 1;
      throw new Error("offline");
    };
    const seeded = await listOpencodeModels("other", "opencode.cmd", offline);
    expect(seeded).toEqual(live);
    expect(calls).toBe(0);
  });

  it("ignores malformed cache files", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cw-opencode-models-")), "opencode-models.json");
    writeFileSync(file, "not json", "utf8");
    initOpencodeModelsCache(file);
    expect(decodeOpencodeModelsCache("not json")).toEqual([]);
    expect(decodeOpencodeModelsCache('{"entries":{"bin":{"at":"x","models":[]}}}')).toEqual([]);
    expect(
      decodeOpencodeModelsCache('{"entries":{"bin":{"at":1,"models":[{"id":"a/b","label":"B","source":"live"}]}}}')
    ).toEqual([{ binary: "bin", at: 1, models: [{ id: "a/b", label: "B", source: "live" }] }]);
  });
});
