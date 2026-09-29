// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { firstDisplayedModelId, getLastModel, getRecentModels, pushRecentModel, setLastModel } from "./lastModel.js";
import type { ModelOption } from "../cw.js";

function opt(id: string): ModelOption {
  return { id, label: id, source: "live" };
}

function resolveInitial(driver: "claude" | "opencode" | "codex", models: ModelOption[]): string | undefined {
  const last = getLastModel(driver);
  return (last && models.some((m) => m.id === last) ? last : undefined) ?? firstDisplayedModelId(driver, models);
}

describe("lastModel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when unset", () => {
    expect(getLastModel("claude")).toBeNull();
  });

  it("round-trips per driver", () => {
    setLastModel("claude", "sonnet");
    setLastModel("opencode", "alpha/m1");
    expect(getLastModel("claude")).toBe("sonnet");
    expect(getLastModel("opencode")).toBe("alpha/m1");
    expect(getLastModel("codex")).toBeNull();
  });

  it("returns undefined for empty lists", () => {
    expect(firstDisplayedModelId("claude", [])).toBeUndefined();
    expect(firstDisplayedModelId("opencode", [])).toBeUndefined();
  });

  it("returns models order for non-opencode drivers", () => {
    expect(firstDisplayedModelId("claude", [opt("b"), opt("a")])).toBe("b");
    expect(firstDisplayedModelId("codex", [opt("b"), opt("a")])).toBe("b");
  });

  it("returns provider-grouped order for opencode", () => {
    const models = [opt("zebra/m2"), opt("alpha/m1"), opt("alpha/m0")];
    expect(firstDisplayedModelId("opencode", models)).toBe("alpha/m1");
  });

  it("picks first when no last is stored", () => {
    const models = [opt("a"), opt("b")];
    expect(resolveInitial("claude", models)).toBe("a");
  });

  it("picks last when valid", () => {
    const models = [opt("a"), opt("b")];
    setLastModel("claude", "b");
    expect(resolveInitial("claude", models)).toBe("b");
  });

  it("picks first when last is not in the list", () => {
    const models = [opt("a"), opt("b")];
    setLastModel("claude", "missing");
    expect(resolveInitial("claude", models)).toBe("a");
  });

  it("keeps the most recent models first", () => {
    pushRecentModel("claude", "a");
    pushRecentModel("claude", "b");
    expect(getRecentModels("claude")).toEqual(["b", "a"]);
    expect(getLastModel("claude")).toBe("b");
  });

  it("moves a repeated model to the front without duplicating it", () => {
    pushRecentModel("codex", "a");
    pushRecentModel("codex", "b");
    pushRecentModel("codex", "a");
    expect(getRecentModels("codex")).toEqual(["a", "b"]);
  });

  it("caps recents at three and drops the oldest", () => {
    for (const id of ["a", "b", "c", "d"]) pushRecentModel("opencode", id);
    expect(getRecentModels("opencode")).toEqual(["d", "c", "b"]);
  });

  it("tracks recents per driver", () => {
    pushRecentModel("claude", "a");
    expect(getRecentModels("codex")).toEqual([]);
  });

  it("ignores empty ids", () => {
    pushRecentModel("claude", "");
    expect(getRecentModels("claude")).toEqual([]);
  });

  it("seeds recents with the legacy last model", () => {
    window.localStorage.setItem("cw:lastModel:claude", "legacy");
    expect(getRecentModels("claude")).toEqual(["legacy"]);
    pushRecentModel("claude", "fresh");
    expect(getRecentModels("claude")).toEqual(["fresh", "legacy"]);
  });

  it("recovers from corrupt stored recents", () => {
    window.localStorage.setItem("cw:recentModels:claude", "not json");
    expect(getRecentModels("claude")).toEqual([]);
    window.localStorage.setItem("cw:recentModels:claude", JSON.stringify({ a: 1 }));
    expect(getRecentModels("claude")).toEqual([]);
    window.localStorage.setItem("cw:recentModels:claude", JSON.stringify(["a", 3, "a", "b", "c", "d"]));
    expect(getRecentModels("claude")).toEqual(["a", "b", "c"]);
    window.localStorage.setItem("cw:recentModels:claude", "not json");
    pushRecentModel("claude", "z");
    expect(getRecentModels("claude")).toEqual(["z"]);
  });
});
