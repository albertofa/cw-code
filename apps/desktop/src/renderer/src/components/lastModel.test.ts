// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { firstDisplayedModelId, getLastModel, setLastModel } from "./lastModel.js";
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
});
